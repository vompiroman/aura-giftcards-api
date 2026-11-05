# Discord webhook security

## Incident: 5 November 2026

A production Discord webhook was embedded in `artifacts/api-server/src/routes/orders.ts`
in commit `8e59ffa` (27 June 2026). Commit `8d4c017` removed the literal from the
current source, but it remained available in public Git history.

The exposed credential was confirmed active, revoked directly with Discord
(HTTP 204), and checked again: HTTP 404 / Discord error 10015 (Unknown Webhook).
No credential values are included in this report. The replacement credential
must be activated in Render before notifications can be considered restored.

Rewriting history is not a substitute for revocation. The historical URL is now
inert; no force push or production history rewrite is required for containment.

## Production configuration

- Store `DISCORD_WEBHOOK_URL` (operations) and `DISCORD_ADMIN_WEBHOOK_URL` (admin)
  only in Render environment settings. Never use browser-exposed `VITE_*` variables.
- Create replacements in the intended private Discord channel. Update only the
  affected variable, choose **Save and deploy**, and verify the deploy is live.
- If the same compromised URL was used for both variables, replace both. Preserve
  unrelated secrets and use separate webhooks when their recipients differ.
- A webhook URL grants posting access. Treat it as a password; Base64 encoding
  does not protect it. Keep it out of source, fixtures, screenshots and logs.

## Prevention and verification

The transports accept only HTTPS webhook endpoints at official Discord hosts,
reject redirects, disable mentions, and never log transport error details that
could contain a webhook token.

Run `node scripts/check-secrets.mjs` before publishing. CI also scans added lines
in every new commit, catching a secret even if a later commit removes it.
Local `.env` files are ignored; forcibly tracked private environment files fail
the check. Safe examples must contain placeholders only.

Run `node --test scripts/test-secret-check.mjs` to verify the guard using synthetic
credentials. Integration tests use short dummy tokens and mocked network calls.
No test sends actual customer data or a message to a real Discord channel.

Existing GitHub secret scanning and push protection were confirmed enabled on
both application repositories. This project-specific check adds Discord URL
coverage independently of GitHub's supported provider patterns.
