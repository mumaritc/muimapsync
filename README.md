# IMAP provider migration

Two Node.js scripts transfer accounts through a local backup. Requires Node.js 22 or newer and IMAP access to both providers. Accounts run sequentially, so 16 accounts of up to 1 GB each do not need to fit in memory. Downloads stream to disk; uploads hold one email (including attachments) in memory at a time.

## Setup and run

```powershell
npm ci
Copy-Item source.example.csv source.csv
Copy-Item destination.example.csv destination.csv
```

Edit both CSV files with your 16 accounts. Match the `id` between the source and destination rows; usernames and passwords may differ. Use unique simple IDs such as `account01` through `account16`. The `secure` field accepts `true` or `false` in any letter case, with surrounding spaces ignored; blank defaults to `true`. CSV passwords containing commas or quotes must be quoted; double any quote within a quoted field. Do not trim spaces from passwords.

```powershell
# Try one account first
node download.mjs --csv source.csv --account account01
node upload.mjs --csv destination.csv --account account01

# Then run all accounts (completed messages are skipped)
node download.mjs --csv source.csv
node upload.mjs --csv destination.csv
```

Both scripts accept `--backup D:\MailBackup`. Always use the same backup directory for both. A failed account sets a nonzero exit code and processing continues with the next account. Rerun the same command after fixing a connection, quota, or credential problem. There are no automatic upload retries after uncertain delivery.

Downloads use 1 MiB chunks and fetch metadata in batches of 200 messages over one connection. This reduces network round trips while preserving per-message checksums and durable progress. Progress reports appear after completed messages at roughly 10-second intervals and at folder completion, showing reused messages, downloaded MiB, and average transfer speed. Provider limits and bandwidth still determine actual speed.

Code updates apply on the next run; an already-running process continues unchanged. To switch versions, wait for `account08: download complete` (or your current account), then press Ctrl+C and wait for the process to exit. If it leaves `backup/.lock`, remove that file only after confirming the process has stopped. Restart with the same CSV and backup directory: completed accounts are revisited, verified emails are reused, and missing or incomplete emails are downloaded. Exclude any account you manually emptied for a restore test from that download CSV so its backup snapshot is preserved.

## What is transferred

### Test restoring into the original account

After downloading and manually clearing the test mailbox, restore the existing backup with:

```powershell
node upload.mjs --csv data.csv --account account01 --force
```

`--force` allows the destination to match the source and prints a warning before modifying the mailbox. Passing the flag acknowledges that warning; no interactive confirmation is required. It appends messages and may create duplicates if messages remain. It does not overwrite mail, reset completed upload receipts, or bypass pending-upload, integrity, or UIDVALIDITY checks. Do not rerun the download after clearing the mailbox: that would replace the current backup manifest with the now-empty mailbox snapshot.

### Included data

- Every folder returned by IMAP LIST that can hold messages: Inbox, Sent, Junk/Spam, Trash, Drafts, custom folders, nested folders, and empty folders. Non-selectable container folders are skipped; child folders are still included.
- Original RFC822 `.eml` bytes, including attachments and headers, plus internal delivery dates.
- Flags supported by the destination. `\Recent` is session-only; `\Deleted` is deliberately omitted so restored messages are not later expunged. Other unsupported flags are reported.
- Folder names and hierarchy, translating the provider's hierarchy separator. Special-use roles are recorded in the backup but are not assigned automatically at the destination.

Source folders are opened read-only. The scripts never delete source messages. This is a copy, not a bidirectional sync: later deletions or flag changes are not applied to messages already uploaded. There is no deduplication against pre-existing destination mail; use empty destination accounts where possible. Gmail-style labels/virtual folders may expose the same message in several folders, and this tool copies each folder membership separately.

## Different Sent/Junk names or namespace layouts

If the new provider uses `Sent Items` instead of `Sent`, create `folders.json`:

```json
{
  "Sent": "Sent Items",
  "Junk": "Spam",
  "INBOX.Archive": "Archive"
}
```

```powershell
node upload.mjs --csv destination.csv --folder-map folders.json
```

Keys are exact source paths (shown during download or in `folder.json`); values are destination paths. Destination namespace prefixes are applied by the IMAP client. Unmapped folders keep their names with the separator translated. Explicitly map source namespace prefixes if they differ. Multiple source folders cannot map to one target. Set mappings before the first upload and keep them unchanged on resume. Use `--account` and separate maps if accounts need different layouts.

## Backup and recovery

The backup contains a hashed account directory with `account.json`, then hashed folder directories with `folder.json`, numbered `.eml` files and message metadata JSON. Hashes avoid unsafe filesystem characters in IMAP folder names. Metadata contains SHA-256 checksums; each message is checked before upload. Account metadata never stores passwords. Do not edit or delete progress files during normal operation.

Uploads save one receipt per source message under `uploads/<destination hash>/<folder hash>/<UID>.json`. Completed receipts prevent repeat uploads to that destination. Keep these receipts with the backup. Changing destination host/user/port creates a separate upload history; do not change these to aliases of the same mailbox mid-migration. Do not run two copies against separate backup copies and the same destination.

If interrupted between sending a message and recording success, its receipt remains `pending`. The next run stops on that message. IMAP cannot guarantee exactly-once delivery across a lost connection. Inspect that message at the destination (compare full contents, date and folder; Message-ID alone is not conclusive). If delivered, change only the receipt's `status` to `done`; if definitely absent, remove only that pending receipt to permit retry. If unsure, keep it pending. This also applies to provider rejections such as quota or message-size limits: confirm absence before removing a receipt.

A `.lock` prevents simultaneous download/upload against the same backup. After a hard crash, verify the earlier process is gone, then remove only `backup/.lock`. UIDVALIDITY changes stop processing because stored message IDs are no longer safe to reuse. Use a fresh backup directory for a fresh source snapshot, and reconcile existing destination mail before uploading that new snapshot to avoid duplicates.

Rerunning a download refreshes the current folder/message snapshot and picks up new arrivals; previously downloaded files are retained, including messages no longer present in the current snapshot. Upload uses only the current complete snapshot. Pause source changes for the final pass, rerun download and upload after mail routing has moved, and check folder counts and sample attachments at the destination before retiring the old provider. IMAP does not transfer contacts, calendars, rules, passwords, or DNS settings.

## Credentials and storage

`secure=true` (default) uses TLS, normally port 993. `secure=false` requires STARTTLS, normally port 143; unencrypted authentication is not allowed. Certificate verification stays enabled. Use provider app passwords when required. For OAuth-only providers, add a `token_env` column naming an environment variable containing an access token; the script does not obtain or refresh OAuth tokens. Alternatively, add a `password_env` column to read passwords from environment variables instead of the CSV.

Allow more than 16 GB free space for 16 full 1 GB accounts, plus metadata, retained snapshots and provider label duplication. The destination also needs adequate quota and must accept each message's size. The backup and CSV contain private data in plaintext: store them on an encrypted disk and restrict access using your operating system. The default backup and credential CSVs are ignored by Git; custom backup paths need their own exclusions.

## Checks

```powershell
npm test
```

The offline check exercises backup/restore with simulated IMAP clients, including raw bytes, dates, flags, empty/nested folders, resume, checksum rejection, and interrupted uploads. It also checks the 200-message batch boundary, out-of-order and missing metadata, larger chunk settings, and recovery from truncated downloads. Real provider authentication and provider-specific behavior still require the single-account trial above.

Library reference: [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/).
