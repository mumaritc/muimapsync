import {
  readFile,
  writeFile,
  rename,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse } from "csv-parse/sync";
import { ImapFlow } from "imapflow";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const identity = (row) => ({
  host: row.host.toLowerCase(),
  port: row.port,
  user: row.user,
  secure: row.secure,
});
export async function json(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function save(file, value) {
  await writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flush: true,
  });
  await rename(file + ".tmp", file);
}
export function accounts(text) {
  let rows;
  try {
    rows = parse(text, {
      columns: (headers) => {
        if (
          new Set(headers).size !== headers.length ||
          ["id", "host", "user"].some((h) => !headers.includes(h))
        )
          throw new Error("Invalid headers");
        return headers;
      },
      bom: true,
      skip_empty_lines: true,
    });
  } catch {
    throw new Error(
      "Invalid CSV: check headers, column counts, and quoted fields.",
    );
  }
  if (!rows.length) throw new Error("CSV contains no accounts");
  const ids = new Set();
  for (const row of rows) {
    for (const key of ["id", "host", "user"]) {
      row[key] = row[key]?.trim();
      if (!row[key]) throw new Error(`Missing CSV field: ${key}`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(row.id) || ids.has(row.id))
      throw new Error(
        "Account IDs must be unique and contain only letters, digits, _ or -",
      );
    ids.add(row.id);
    row.secure = (row.secure ?? "").trim().toLowerCase();
    if (!["true", "false", ""].includes(row.secure))
      throw new Error(
        `Invalid secure value for ${row.id}; use true or false (blank defaults to true)`,
      );
    row.secure = row.secure !== "false";
    row.port = Number(row.port || (row.secure ? 993 : 143));
    if (!Number.isInteger(row.port) || row.port < 1 || row.port > 65535)
      throw new Error(`Invalid port for ${row.id}`);
    row.password = row.password_env
      ? process.env[row.password_env]
      : row.password;
    row.accessToken = row.token_env ? process.env[row.token_env] : undefined;
    if (!row.password && !row.accessToken)
      throw new Error(`Missing password or token for ${row.id}`);
  }
  return rows;
}
export function main(moduleUrl, work, mode) {
  if (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === moduleUrl
  ) {
    run(work, mode).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
async function run(work, mode) {
  const { values } = parseArgs({
    options: {
      csv: { type: "string" },
      backup: { type: "string", default: "backup" },
      account: { type: "string" },
      "folder-map": { type: "string" },
      help: { type: "boolean" },
      ...(mode === "upload"
        ? { force: { type: "boolean", default: false } }
        : {}),
    },
  });
  if (values.help) {
    console.log(
      `node ${mode}.mjs --csv ${mode === "download" ? "source" : "destination"}.csv [--backup backup] [--account account01] [--folder-map folders.json]${mode === "upload" ? " [--force]" : ""}`,
    );
    if (mode === "upload")
      console.log(
        "--force: allow restoring into the source account, with a warning. Appends mail; does not overwrite or reset progress.",
      );
    return;
  }
  if (!values.csv) throw new Error("--csv is required; see --help");
  let rows = accounts(await readFile(values.csv, "utf8"));
  if (values.account) rows = rows.filter((row) => row.id === values.account);
  if (!rows.length) throw new Error("Selected account was not found");
  const mapping = values["folder-map"] ? await json(values["folder-map"]) : {};
  if (
    !mapping ||
    Array.isArray(mapping) ||
    typeof mapping !== "object" ||
    Object.values(mapping).some((v) => typeof v !== "string" || !v)
  )
    throw new Error(
      "Folder map must be a JSON object with nonempty destination paths",
    );
  const base = resolve(values.backup);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const lockPath = join(base, ".lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `Backup is locked: ${lockPath}. If a previous process crashed, verify it has stopped before removing this file.`,
      );
    throw error;
  }
  try {
    await lock.writeFile(`${process.pid}\n`);
    // ponytail: one account at a time; add bounded concurrency only if migration speed requires it.
    for (const row of rows) {
      const client = new ImapFlow({
        host: row.host,
        port: row.port,
        secure: row.secure,
        ...(row.secure ? {} : { doSTARTTLS: true }),
        auth: {
          user: row.user,
          ...(row.accessToken
            ? { accessToken: row.accessToken }
            : { pass: row.password }),
        },
        logger: false,
        disableAutoIdle: true,
        socketTimeout: 300000,
      });
      client.on("error", () => client.close());
      try {
        await client.connect();
        await work(client, row, join(base, hash(row.id)), mapping, {
          force: values.force,
        });
        console.log(`${row.id}: ${mode} complete`);
      } catch (error) {
        // Do not print server responses, which may include authentication details.
        const code = String(
          error.serverResponseCode || error.code || error.name,
        )
          .replace(/[^a-zA-Z0-9_-]/g, "")
          .slice(0, 60);
        console.error(
          `${row.id}: FAILED (${code}). ${error.safeMessage || "See local progress files; fix the connection or provider error, then rerun."}`,
        );
        process.exitCode = 1;
      } finally {
        await client.logout().catch(() => client.close());
      }
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export function fail(message) {
  const error = new Error(message);
  error.safeMessage = message;
  throw error;
}
