# muimapsync

Back up and migrate IMAP mailboxes between providers using two Node.js scripts and CSV account lists. Download mail to a local backup, then restore it to the destination provider with per-message progress tracking.

- Copy Inbox, Sent, Junk, Trash, Drafts, custom folders, and attachments.
- Preserve original message bytes, internal dates, and supported flags.
- Resume interrupted transfers and verify backups with SHA-256 checksums.
- Map folder names between providers and process multiple accounts sequentially.
- Download with 1 MiB chunks and metadata batches of 200 messages.

No database or web server is required. Downloads stream to disk; uploads hold one email, including attachments, in memory at a time. This project copies mail; it does not delete source messages or synchronize deletions.

## Requirements

- Node.js 22 or newer and npm.
- IMAP enabled on both providers, with passwords, app passwords, or OAuth access tokens.
- Destination mailboxes already created, with enough quota for the transferred mail.
- Disk space for the raw mail plus metadata and any retained snapshots. For 16 accounts containing 1 GB each, allow more than 16 GB. Label-based providers can expose additional copies across folders.

## Setup and run

Download and extract this repository, or clone it:

```sh
git clone https://github.com/mumaritc/muimapsync.git
cd muimapsync
```

Install dependencies and copy the CSV templates:

```powershell
npm ci
Copy-Item source.example.csv source.csv
Copy-Item destination.example.csv destination.csv
```

On macOS or Linux, use `cp` instead of `Copy-Item`. All `node` and `npm` commands are the same.

Edit both CSV files with your accounts. Match the `id` between the source and destination rows; usernames and passwords may differ. Use unique IDs containing letters, digits, underscores, or hyphens, such as `account01`.

Source CSV example:

```csv
id,host,port,secure,user,password
account01,imap.old-provider.example,993,true,person@example.com,"source-app-password"
```

Destination CSV example:

```csv
id,host,port,secure,user,password
account01,imap.new-provider.example,993,true,person@example.com,"destination-app-password"
```

| CSV field | Meaning |
| --- | --- |
| `id` | Stable identifier linking the source account, backup, and destination account. |
| `host` | Provider's IMAP hostname. |
| `port` | Defaults to `993` for TLS or `143` for STARTTLS. |
| `secure` | `true` for TLS; `false` for required STARTTLS. Case and surrounding spaces are ignored; blank defaults to `true`. |
| `user` | IMAP login, usually the full email address. |
| `password` | Password or provider app password. Preserve any leading/trailing spaces. |
| `password_env` | Optional environment variable name to read instead of `password`. |
| `token_env` | Optional environment variable containing an OAuth access token; takes precedence over password authentication. |

CSV passwords containing commas or quotes must be quoted; double any quote within a quoted field. Never commit filled account CSVs.

```powershell
# Try one account first
node download.mjs --csv source.csv --account account01
node upload.mjs --csv destination.csv --account account01

# Then run all accounts (completed messages are skipped)
node download.mjs --csv source.csv
node upload.mjs --csv destination.csv
```

Both scripts accept `--backup D:\MailBackup`. Always use the same backup directory for both. A failed account sets a nonzero exit code and processing continues with the next account. Rerun the same command after fixing a connection, quota, or credential problem. There are no automatic upload retries after uncertain delivery.

### Command reference

| Option | Use |
| --- | --- |
| `--csv <file>` | Required account CSV. |
| `--backup <directory>` | Backup location; defaults to `backup` in the current directory. |
| `--account <id>` | Process only the matching account. Without it, process all CSV rows. |
| `--folder-map <file>` | JSON source-to-destination folder mapping for upload. |
| `--force` | Upload only: allow restoring into the original source account, with a warning. |
| `--help` | Show command usage. |

```powershell
node download.mjs --csv source.csv --backup D:\MailBackup
node upload.mjs --csv destination.csv --backup D:\MailBackup
```

### Performance and restarting

Downloads use 1 MiB chunks and fetch metadata in batches of 200 messages over one connection. This reduces network round trips while preserving per-message checksums and durable progress. Progress reports appear after completed messages at roughly 10-second intervals and at folder completion, showing reused messages, downloaded MiB, and average transfer speed. Provider limits and bandwidth still determine actual speed.

Code updates apply on the next run; an already-running process continues unchanged. To switch versions, wait for the current account's `download complete` message, then press Ctrl+C and wait for the process to exit. If it leaves `backup/.lock`, remove that file only after confirming the process has stopped. Restart with the same CSV and backup directory: completed accounts are revisited, verified emails are reused, and missing or incomplete emails are downloaded. Exclude any account you manually emptied for a restore test from that download CSV so its backup snapshot is preserved.

## What is transferred

### Test restoring into the original account

After downloading and manually clearing the test mailbox, restore the existing backup with:

```powershell
node upload.mjs --csv source.csv --account account01 --force
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

## Troubleshooting

| Problem | Next step |
| --- | --- |
| CSV validation fails | Check the required headers, unique IDs, quoting, and `secure` values. |
| Authentication or connection fails | Check IMAP access, host, port, TLS mode, and app-password/token requirements. Tokens are not refreshed automatically. |
| Backup is locked | Wait for the other process. Remove `.lock` only after confirming no transfer is using that backup. |
| Backup is incomplete | Finish or resume its download before uploading. |
| Backup integrity check fails | For a still-intact source, rerun download to repair cached content. For an emptied source, recover the affected file from another backup instead. |
| Uncertain upload / pending receipt | Follow the recovery steps above; do not blindly retry or clear all receipts. |
| Destination equals source | Use `--force` only for an intentional same-account restore. |
| UIDVALIDITY changed | Stop and reconcile the mailbox with its backup/progress records before starting a fresh migration. |
| Provider rejects a large message or quota is full | Resolve the provider limit, verify whether the message arrived, then follow pending-receipt recovery. |

## Contributing

Run `npm ci` and `npm test` before submitting a change. Keep tests offline and use synthetic messages. When reporting a problem, include the command with personal paths removed, Node.js version, and sanitized error text. Do not attach account CSVs, tokens, raw emails, or private backup metadata.

## License

[MIT](LICENSE) — Copyright (c) 2026 mumaritc.
