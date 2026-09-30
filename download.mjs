import { mkdir, rename, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hash, identity, json, save, main, fail } from "./common.mjs";

export async function downloadAccount(client, row, dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const accountFile = join(dir, "account.json");
  const previous = await json(accountFile, null);
  if (
    previous &&
    JSON.stringify(previous.source) !== JSON.stringify(identity(row))
  )
    fail("Source identity changed. Use a new backup directory.");
  const folders = (await client.list()).filter(
    (folder) => !folder.flags.has("\\Noselect"),
  );
  const account = {
    id: row.id,
    source: identity(row),
    complete: false,
    folders: folders.map((f) => hash(f.path)),
  };
  await save(accountFile, account);
  for (const folder of folders) {
    const folderDir = join(dir, hash(folder.path));
    await mkdir(folderDir, { recursive: true, mode: 0o700 });
    const box = await client.mailboxOpen(folder.path, { readOnly: true });
    const manifestFile = join(folderDir, "folder.json");
    const old = await json(manifestFile, null);
    const uidValidity = String(box.uidValidity);
    if (old && old.uidValidity !== uidValidity)
      fail(
        `UIDVALIDITY changed for ${folder.path}; use a new backup directory to avoid confusing message IDs.`,
      );
    const uids = await client.search({ all: true }, { uid: true });
    if (!Array.isArray(uids)) fail(`Could not list messages in ${folder.path}`);
    const manifest = {
      path: folder.path,
      delimiter: folder.delimiter,
      specialUse: folder.specialUse,
      uidValidity,
      uids,
      complete: false,
    };
    await save(manifestFile, manifest);
    let count = 0;
    let reused = 0;
    let transferred = 0;
    const started = performance.now();
    let reported = started;
    for (let offset = 0; offset < uids.length; offset += 200) {
      const batch = uids.slice(offset, offset + 200);
      // Finish FETCH before issuing downloads on the same connection.
      const messages = await client.fetchAll(
        batch,
        { uid: true, flags: true, internalDate: true, size: true },
        { uid: true },
      );
      const metadata = new Map(messages.map((meta) => [meta.uid, meta]));
      if (
        metadata.size !== batch.length ||
        messages.length !== batch.length ||
        batch.some((uid) => !metadata.has(uid))
      ) {
        fail(
          `Missing or unexpected message metadata in ${folder.path}; rerun to take a new snapshot.`,
        );
      }
      for (const uid of batch) {
        const prefix = join(folderDir, String(uid));
        const meta = metadata.get(uid);
        const date = new Date(meta.internalDate);
        if (
          !meta.internalDate ||
          !Number.isFinite(date.getTime()) ||
          !Number.isSafeInteger(meta.size) ||
          meta.size < 0 ||
          !(meta.flags instanceof Set)
        ) {
          fail(`Invalid message metadata in ${folder.path} UID ${uid}`);
        }
        const cached = await json(prefix + ".json", null);
        const size = await stat(prefix + ".eml")
          .then((s) => s.size)
          .catch((e) => {
            if (e.code === "ENOENT") return -1;
            throw e;
          });
        let digest = cached?.sha256;
        let intact = cached && size === meta.size && cached.size === size;
        if (intact) {
          const check = createHash("sha256");
          for await (const chunk of createReadStream(prefix + ".eml"))
            check.update(chunk);
          intact = check.digest("hex") === cached.sha256;
        }
        if (!intact) {
          const sha = createHash("sha256");
          let bytes = 0;
          const { content } = await client.download(String(uid), undefined, {
            uid: true,
            chunkSize: 1024 * 1024,
          });
          await pipeline(
            content,
            new Transform({
              transform(chunk, encoding, callback) {
                bytes += chunk.length;
                sha.update(chunk);
                callback(null, chunk);
              },
            }),
            createWriteStream(prefix + ".eml.tmp", { mode: 0o600 }),
          );
          if (bytes !== meta.size)
            fail(`Incomplete download of ${folder.path} UID ${uid}`);
          digest = sha.digest("hex");
          await rename(prefix + ".eml.tmp", prefix + ".eml");
          transferred += bytes;
        } else {
          reused++;
        }
        await save(prefix + ".json", {
          uid,
          flags: [...meta.flags],
          internalDate: date.toISOString(),
          size: meta.size,
          sha256: digest,
        });
        count++;
        const now = performance.now();
        if (now - reported >= 10000 || count === uids.length) {
          const mib = transferred / (1024 * 1024);
          console.log(
            `${row.id}: ${folder.path} ${count}/${uids.length}, ${reused} reused, ${mib.toFixed(2)} MiB downloaded, ${(mib / Math.max((now - started) / 1000, 0.001)).toFixed(2)} MiB/s average`,
          );
          reported = now;
        }
      }
    }
    manifest.complete = true;
    await save(manifestFile, manifest);
    console.log(
      `${row.id}: backed up ${folder.path} (${uids.length} messages)`,
    );
  }
  account.complete = true;
  account.finishedAt = new Date().toISOString();
  await save(accountFile, account);
}
main(import.meta.url, downloadAccount, "download");
