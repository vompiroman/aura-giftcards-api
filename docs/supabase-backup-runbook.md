# Supabase backup and restore runbook

This runbook is deliberately operational: it does not create a backup
automatically and it never restores over the production project.

## Choose the backup source by plan

### Pro, Team and Enterprise

Use the managed daily backups shown in the Supabase dashboard as the primary
recovery source. Check the project's **Database → Backups** page for the
current retention window and point-in-time/restore options available to the
subscription. Retention and restore capabilities are plan-specific and must
be confirmed in the dashboard before promising an RPO/RTO.

At least once per month, perform a non-production restore drill (below) and
record the backup timestamp, schema version and verification result.

### Free

Do not assume managed daily backups are available. Export an encrypted dump to
storage controlled by the team:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dump = "backups/supabase-$stamp.sql"
supabase db dump --project-ref $env:SUPABASE_PROJECT_REF --file $dump
Get-FileHash $dump -Algorithm SHA256 | Format-List
```

Store the dump and its SHA-256 manifest outside the repository. Do not put
database URLs, service-role keys or other secrets in the dump manifest or in
Git. Keep at least three dated copies in separate storage locations and test
one copy monthly.

## Non-destructive restore drill

1. Create or select a **separate Supabase project**, preview branch, or local
   Postgres instance. It must not be the production project and must have
   separate credentials.
2. Download one managed backup (paid plans) or one external dump (Free).
3. Verify the dump before importing:

   ```powershell
   node scripts/verify-supabase-backup.mjs `
     .\backups\supabase-YYYYMMDD-HHmmss.sql `
     .\backups\SHA256SUMS
   ```

4. Apply the dump only to the isolated target. For a local target:

   ```powershell
   psql "$env:DRILL_DATABASE_URL" --single-transaction `
     --file .\backups\supabase-YYYYMMDD-HHmmss.sql
   ```

   For a Supabase drill project, use its SQL Editor or the documented
   `supabase db push`/restore workflow with that project's URL.
5. Run read-only smoke checks: table counts, a sample order status, RLS access
   checks, and the application health endpoint configured for the drill
   project. Never copy production secrets into the drill project.
6. Record elapsed restore time, failed objects, row-count differences and the
   backup timestamp. Fix the runbook or schema before the next drill.

No command in this repository performs a production restore automatically.
Any production recovery requires a separate, reviewed change, an explicit
operator confirmation and a fresh backup/rollback plan.

## Integrity verification

`scripts/verify-supabase-backup.mjs` checks that a dump is non-empty and that
its SHA-256 digest matches a line in the supplied manifest. A failed check
must stop the restore.
