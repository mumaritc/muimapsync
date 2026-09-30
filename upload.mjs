import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hash, identity, json, save, main, fail } from "./common.mjs";

export function destinationPath(folder, mapping, delimiter) {
  if (Object.hasOwn(mapping, folder.path)) return mapping[folder.path];
  if (folder.path.toUpperCase() === "INBOX") return "INBOX";
  const parts = folder.delimiter
    ? folder.path.split(folder.delimiter)
    : [folder.path];
  if (
    (!delimiter && parts.length > 1) ||
    (delimiter &&
      delimiter !== folder.delimiter &&
      parts.some((p) => p.includes(delimiter)))
  )
    fail(`Cannot translate folder ${folder.path}; provide --folder-map`);
  return parts.join(delimiter || "");
}
export async function uploadAccount(
  client,
  row,
  dir,
  mapping = {},
  { force = false } = {},
) {
  const account = await json(join(dir, "account.json"));
  if (!account.complete || account.id !== row.id)
    fail(
      "Backup is incomplete or account ID does not match. Finish download first.",
    );
  if (JSON.stringify(account.source) === JSON.stringify(identity(row))) {
    if (!force)
      fail(
        "Destination equals source; refusing to duplicate mail into the source. Use --force to intentionally restore into this account.",
      );
    console.warn(
      `${row.id}: WARNING: --force is restoring into the source account. Existing messages may be duplicated. This appends mail; it does not overwrite or delete messages. Resume and integrity checks remain active.`,
    );
  }
  const stateDir = join(dir, "uploads", hash(JSON.stringify(identity(row))));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const existing = await client.list();
  const inbox = existing.find((f) => f.path.toUpperCase() === "INBOX");
  const delimiter =
    client.namespace?.delimiter ?? inbox?.delimiter ?? existing[0]?.delimiter;
  const folders = await Promise.all(
    account.folders.map((id) => json(join(dir, id, "folder.json"))),
  );
  const targets = folders.map((folder) => {
    const path = destinationPath(folder, mapping, delimiter);
    const prefix = client.namespace?.prefix;
    return path.toUpperCase() === "INBOX"
      ? "INBOX"
      : prefix && !path.startsWith(prefix)
        ? prefix + path
        : path;
  });
  if (
    new Set(targets.map((p) => (p.toUpperCase() === "INBOX" ? "INBOX" : p)))
      .size !== targets.length
  )
    fail(
      "Multiple source folders map to the same destination; use distinct folder mappings.",
    );
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index];
    if (!folder.complete) fail(`Incomplete folder backup: ${folder.path}`);
    const target = targets[index];
    const folderDir = join(dir, account.folders[index]);
    const progressDir = join(stateDir, account.folders[index]);
    await mkdir(progressDir, { recursive: true, mode: 0o700 });
    const bindingFile = join(progressDir, "folder.json");
    const binding = await json(bindingFile, null);
    if (
      binding &&
      (binding.target !== target ||
        binding.sourceUidValidity !== folder.uidValidity)
    )
      fail(
        `Folder mapping or source UIDVALIDITY changed for ${folder.path}; restore the previous mapping.`,
      );
    if (!existing.some((f) => f.path === target))
      await client.mailboxCreate(target);
    const box = await client.mailboxOpen(target);
    if (binding && binding.targetUidValidity !== String(box.uidValidity))
      fail(
        `Destination UIDVALIDITY changed for ${target}; review previously uploaded mail before continuing.`,
      );
    await save(bindingFile, {
      target,
      sourceUidValidity: folder.uidValidity,
      targetUidValidity: String(box.uidValidity),
    });
    await client.mailboxSubscribe(target);
    let count = 0;
    for (const uid of folder.uids) {
      const receiptFile = join(progressDir, `${uid}.json`);
      const receipt = await json(receiptFile, null);
      if (receipt?.status === "done") {
        count++;
        continue;
      }
      if (receipt)
        fail(
          `Uncertain upload: ${receiptFile}. Check the destination before changing this receipt; see README.`,
        );
      const meta = await json(join(folderDir, `${uid}.json`));
      // ponytail: one message buffer in memory; use a streaming APPEND client if individual messages exceed available RAM.
      const content = await readFile(join(folderDir, `${uid}.eml`));
      if (content.length !== meta.size || hash(content) !== meta.sha256)
        fail(`Backup integrity check failed for ${folder.path} UID ${uid}`);
      const permanent = box.permanentFlags;
      const flags = meta.flags.filter(
        (f) =>
          !["\\Recent", "\\Deleted"].includes(f) &&
          (!permanent || permanent.has("\\*") || permanent.has(f)),
      );
      const omitted = meta.flags.filter(
        (f) => !flags.includes(f) && f !== "\\Recent",
      );
      if (omitted.length)
        console.log(
          `${row.id}: ${folder.path} UID ${uid}: omitted flags ${omitted.join(", ")}`,
        );
      await save(receiptFile, {
        status: "pending",
        target,
        sourceUid: uid,
        sha256: meta.sha256,
      });
      const result = await client.append(
        target,
        content,
        flags,
        new Date(meta.internalDate),
      );
      if (!result)
        fail(
          `APPEND was not confirmed. Review pending receipt: ${receiptFile}`,
        );
      if (
        result.uidValidity &&
        String(result.uidValidity) !== String(box.uidValidity)
      )
        fail(`Destination changed during upload; review ${receiptFile}`);
      await save(receiptFile, {
        status: "done",
        target,
        sourceUid: uid,
        sha256: meta.sha256,
        targetUid: result.uid ? String(result.uid) : null,
      });
      if (++count % 100 === 0)
        console.log(`${row.id}: ${target} ${count}/${folder.uids.length}`);
    }
    console.log(
      `${row.id}: restored ${folder.path} -> ${target} (${count} messages)`,
    );
  }
}
main(import.meta.url, uploadAccount, "upload");
