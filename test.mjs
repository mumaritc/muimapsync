import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { accounts, hash, identity, json } from "./common.mjs";
import { downloadAccount } from "./download.mjs";
import { uploadAccount, destinationPath } from "./upload.mjs";

const root = await mkdtemp(join(tmpdir(), "muimapsync-test-"));
try {
  const [source] = accounts(
    'id,host,user,password\na,old.example,user,"comma, and ""quote"""\n',
  );
  assert.equal(source.password, 'comma, and "quote"');
  assert.equal(source.port, 993);
  for (const [value, expected] of [
    ["TRUE", true],
    [" true ", true],
    ["FALSE", false],
    [" False ", false],
    ["", true],
    ["   ", true],
  ]) {
    const [row] = accounts(
      `id,host,user,password,secure\na,h,u, password ,${value}`,
    );
    assert.equal(row.secure, expected);
    assert.equal(row.port, expected ? 993 : 143);
    assert.equal(row.password, " password ");
  }
  assert.throws(
    () => accounts("id,host,user,password\na,h,u,p\na,h,u,p"),
    /unique/,
  );
  assert.throws(
    () => accounts("id,host,user,password,secure\na,h,u,p,maybe"),
    /secure/,
  );
  assert.throws(
    () => accounts('id,host,user,password\na,h,u,"SECRET"broken'),
    (error) => !error.message.includes("SECRET"),
  );
  assert.equal(
    destinationPath({ path: "Work/2026", delimiter: "/" }, {}, "."),
    "Work.2026",
  );
  assert.throws(
    () => destinationPath({ path: "Work.v1/2026", delimiter: "/" }, {}, "."),
    /folder-map/,
  );
  const destination = { ...source, host: "new.example" };
  const raw = Buffer.from(
    "From: a@example.com\r\nSubject: Test\r\n\r\nBody\r\n",
  );
  const date = new Date("2020-01-02T03:04:05Z");
  let downloads = 0;
  let validity = 1n;
  let selected;
  const folders = ["INBOX", "Sent", "Junk", "Work/2026", "Empty"];
  const sourceClient = {
    async list() {
      return [
        ...folders.map((path) => ({ path, delimiter: "/", flags: new Set() })),
        { path: "Container", flags: new Set(["\\Noselect"]) },
      ];
    },
    async mailboxOpen(path, options) {
      assert.equal(options.readOnly, true);
      selected = path;
      return { uidValidity: validity };
    },
    async search() {
      return selected === "Empty" ? [] : [7];
    },
    async fetchAll(uids, query, options) {
      assert.deepEqual(uids, [7]);
      assert.equal(options.uid, true);
      assert.equal(
        query.source,
        undefined,
        "metadata batches must not buffer message bodies",
      );
      return [
        {
          uid: 7,
          size: raw.length,
          flags: new Set(["\\Seen", "\\Deleted"]),
          internalDate: date,
        },
      ];
    },
    async download(uid, part, options) {
      assert.equal(options.chunkSize, 1024 * 1024);
      assert.equal(options.uid, true);
      downloads++;
      return { content: Readable.from([raw]) };
    },
  };
  await downloadAccount(sourceClient, source, root);
  await downloadAccount(sourceClient, source, root);
  assert.equal(downloads, 4, "resume must reuse complete messages");
  assert.deepEqual(await readFile(join(root, hash("INBOX"), "7.eml")), raw);
  let appends = 0;
  let disconnect = false;
  const targetFolders = new Set(["INBOX"]);
  const targetClient = {
    namespace: { prefix: "Mail.", delimiter: "." },
    async list() {
      return [...targetFolders].map((path) => ({ path, delimiter: "." }));
    },
    async mailboxCreate(path) {
      targetFolders.add(path);
    },
    async mailboxOpen() {
      return { uidValidity: 2n, permanentFlags: new Set(["\\Seen"]) };
    },
    async mailboxSubscribe() {},
    async append(path, content, flags, internalDate) {
      appends++;
      assert.deepEqual(content, raw);
      assert.deepEqual(flags, ["\\Seen"]);
      assert.equal(internalDate.toISOString(), date.toISOString());
      if (disconnect)
        throw new Error("Connection dropped after possible delivery");
      return { uid: appends, uidValidity: 2n };
    },
  };
  await uploadAccount(targetClient, destination, root);
  await uploadAccount(targetClient, destination, root);
  assert.equal(appends, 4, "resume must not append completed messages");
  assert.ok(targetFolders.has("Mail.Work.2026"));
  assert.ok(targetFolders.has("Mail.Empty"));
  await assert.rejects(
    uploadAccount(targetClient, source, root),
    /equals source/,
  );
  await assert.rejects(
    uploadAccount(targetClient, destination, root, { Sent: "INBOX" }),
    /Multiple source/,
  );
  const state = join(
    root,
    "uploads",
    hash(JSON.stringify(identity(destination))),
    hash("INBOX"),
    "7.json",
  );
  await rm(state);
  const eml = join(root, hash("INBOX"), "7.eml");
  await writeFile(eml, Buffer.alloc(raw.length, 65));
  await assert.rejects(
    uploadAccount(targetClient, destination, root),
    /integrity/,
  );
  assert.equal(appends, 4);
  await downloadAccount(sourceClient, source, root);
  assert.equal(downloads, 5, "download should repair corrupted cached content");
  assert.deepEqual(await readFile(eml), raw);
  disconnect = true;
  await assert.rejects(
    uploadAccount(targetClient, destination, root),
    /Connection dropped/,
  );
  assert.equal((await json(state)).status, "pending");
  disconnect = false;
  await assert.rejects(
    uploadAccount(targetClient, destination, root),
    /Uncertain upload/,
  );
  assert.equal(
    appends,
    5,
    "uncertain delivery must never be retried automatically",
  );
  const warnings = [];
  const warn = console.warn;
  const forcedClient = {
    ...targetClient,
    async append(...args) {
      assert.ok(
        warnings.length,
        "warning must precede the first forced append",
      );
      return targetClient.append(...args);
    },
  };
  console.warn = (message) => warnings.push(message);
  try {
    await uploadAccount(forcedClient, source, root, {}, { force: true });
    assert.equal(appends, 9, "force must allow a same-account restore");
    assert.match(warnings[0], /WARNING.*duplicated/);
    await uploadAccount(forcedClient, source, root, {}, { force: true });
    assert.equal(appends, 9, "force must preserve completed receipts");
    await assert.rejects(
      uploadAccount(targetClient, destination, root, {}, { force: true }),
      /Uncertain upload/,
    );
  } finally {
    console.warn = warn;
  }
  validity = 9n;
  await assert.rejects(
    downloadAccount(sourceClient, source, root),
    /UIDVALIDITY/,
  );
  await assert.rejects(
    uploadAccount(targetClient, destination, root),
    /incomplete/,
  );
  await assert.rejects(
    uploadAccount(targetClient, source, root, {}, { force: true }),
    /incomplete/,
  );
  const batchRoot = join(root, "batch-check");
  const batchUids = Array.from({ length: 201 }, (_, index) => index + 1);
  const bodies = new Map(
    batchUids.map((uid) => [
      uid,
      Buffer.from(`Subject: UID ${uid}\r\n\r\n${"x".repeat(uid)}\r\n`),
    ]),
  );
  let fetchSizes = [];
  const downloaded = [];
  let failure = "truncated";
  const batchClient = {
    async list() {
      return [{ path: "INBOX", delimiter: "/", flags: new Set() }];
    },
    async mailboxOpen() {
      return { uidValidity: 1n };
    },
    async search() {
      return batchUids;
    },
    async fetchAll(uids) {
      fetchSizes.push(uids.length);
      const result = [...uids]
        .reverse()
        .map((uid) => ({
          uid,
          size: bodies.get(uid).length,
          flags: new Set(),
          internalDate: date,
        }));
      if (failure === "missing") result.pop();
      if (failure === "invalid") result[0].size = undefined;
      return result;
    },
    async download(uid, part, options) {
      assert.equal(options.chunkSize, 1024 * 1024);
      downloaded.push(Number(uid));
      const body = bodies.get(Number(uid));
      return {
        content: Readable.from([
          failure === "truncated" && uid === "3" ? body.subarray(1) : body,
        ]),
      };
    },
  };
  await assert.rejects(
    downloadAccount(batchClient, source, batchRoot),
    /Incomplete download/,
  );
  assert.equal((await json(join(batchRoot, "account.json"))).complete, false);
  assert.equal(
    (await json(join(batchRoot, hash("INBOX"), "folder.json"))).complete,
    false,
  );
  assert.equal(
    await json(join(batchRoot, hash("INBOX"), "3.json"), null),
    null,
  );
  failure = null;
  fetchSizes = [];
  await downloadAccount(batchClient, source, batchRoot);
  assert.deepEqual(
    fetchSizes,
    [200, 1],
    "201 messages require two metadata requests",
  );
  assert.equal(
    downloaded.filter((uid) => uid === 1 || uid === 2).length,
    2,
    "resume must reuse messages completed before interruption",
  );
  assert.equal(
    downloaded.filter((uid) => uid === 3).length,
    2,
    "truncated message must be retried",
  );
  for (const uid of batchUids)
    assert.deepEqual(
      await readFile(join(batchRoot, hash("INBOX"), `${uid}.eml`)),
      bodies.get(uid),
    );
  for (failure of ["missing", "invalid"]) {
    await assert.rejects(
      downloadAccount(batchClient, source, batchRoot),
      /message metadata/,
    );
    assert.equal((await json(join(batchRoot, "account.json"))).complete, false);
    assert.equal(
      (await json(join(batchRoot, hash("INBOX"), "folder.json"))).complete,
      false,
    );
  }
  console.log(
    "PASS: CSV, raw backup, dates, flags, all folders, namespace mapping, resume, integrity, and uncertain upload protection",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
