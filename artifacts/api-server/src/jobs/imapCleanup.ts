import { ImapFlow } from 'imapflow';

export interface CleanupConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  archiveAfterHours: number;
  purgeAfterHours: number;
  safetyWindowMinutes: number;
  processedFolder: string;
  maxInboxMessages: number;
}

function loadConfig(): CleanupConfig {
  const host = process.env.IMAP_ADMIN_HOST || '';
  const port = Number(process.env.IMAP_ADMIN_PORT || 993);
  const user = process.env.IMAP_ADMIN_USER || '';
  const pass = process.env.IMAP_ADMIN_PASS || process.env.DEFAULT_IMAP_PASSWORD || '';

  if (!host || !user || !pass || port !== 993) {
    throw new Error('IMAP_ADMIN_HOST, IMAP_ADMIN_USER and IMAP_ADMIN_PASS are required; port must be 993.');
  }

  return {
    host,
    port,
    user,
    pass,
    archiveAfterHours: Number(process.env.IMAP_ARCHIVE_AFTER_HOURS || 24),
    purgeAfterHours: Number(process.env.IMAP_PURGE_AFTER_HOURS || 168),
    safetyWindowMinutes: Number(process.env.IMAP_SAFETY_WINDOW_MIN || 30),
    processedFolder: process.env.IMAP_PROCESSED_FOLDER || 'Processed',
    maxInboxMessages: Number(process.env.IMAP_MAX_INBOX || 1000),
  };
}

async function ensureFolder(client: ImapFlow, folder: string): Promise<void> {
  const list = await client.list();
  const exists = list.some((box) => box.path === folder);
  if (!exists) {
    await client.mailboxCreate(folder);
    console.log(`[cleanup] Dossier "${folder}" crÃƒÂ©ÃƒÂ©.`);
  }
}

async function findUidsBefore(client: ImapFlow, before: Date): Promise<number[]> {
  const uids = await client.search({ before }, { uid: true });
  return Array.isArray(uids) ? uids : [];
}

async function archiveOldInbox(client: ImapFlow, cfg: CleanupConfig): Promise<number> {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const status = await client.status('INBOX', { messages: true });
    const total = status.messages ?? 0;

    const effectiveHours =
      total > cfg.maxInboxMessages
        ? Math.max(2, Math.floor(cfg.archiveAfterHours / 2))
        : cfg.archiveAfterHours;

    const cutoff = new Date(Date.now() - effectiveHours * 3600_000);
    const safety = new Date(Date.now() - cfg.safetyWindowMinutes * 60_000);
    const effectiveCutoff = cutoff < safety ? cutoff : safety;

    const uids = await findUidsBefore(client, effectiveCutoff);
    if (uids.length === 0) return 0;

    await client.messageMove(uids, cfg.processedFolder, { uid: true });
    console.log(
      `[cleanup] ${uids.length} mail(s) archivÃƒÂ©(s) vers "${cfg.processedFolder}" (cutoff ${effectiveHours} h, INBOX=${total}).`
    );
    return uids.length;
  } finally {
    lock.release();
  }
}

async function purgeOldProcessed(client: ImapFlow, cfg: CleanupConfig): Promise<number> {
  const lock = await client.getMailboxLock(cfg.processedFolder);
  try {
    const cutoff = new Date(Date.now() - cfg.purgeAfterHours * 3600_000);
    const uids = await findUidsBefore(client, cutoff);
    if (uids.length === 0) return 0;

    await client.messageDelete(uids, { uid: true });
    console.log(
      `[cleanup] ${uids.length} mail(s) purgÃƒÂ©(s) de "${cfg.processedFolder}" (rÃƒÂ©tention ${cfg.purgeAfterHours} h).`
    );
    return uids.length;
  } finally {
    lock.release();
  }
}

let isRunning = false;

export async function runCleanupCycle(): Promise<{ archived: number; purged: number }> {
  if (isRunning) {
    console.warn('[cleanup] Cycle dÃƒÂ©jÃƒÂ  en cours, exÃƒÂ©cution sautÃƒÂ©e.');
    return { archived: 0, purged: 0 };
  }
  isRunning = true;

  const cfg = loadConfig();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    tls: { rejectUnauthorized: true },
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    clientInfo: { name: 'AuraStream-Cleanup', version: '1.0.0' },
  });

  try {
    await client.connect();
    await ensureFolder(client, cfg.processedFolder);

    const archived = await archiveOldInbox(client, cfg);
    const purged = await purgeOldProcessed(client, cfg);

    console.log(`[cleanup] Cycle terminÃƒÂ© : ${archived} archivÃƒÂ©(s), ${purged} purgÃƒÂ©(s).`);
    return { archived, purged };
  } catch (err: any) {
    console.error('[cleanup] Ãƒâ€°chec du cycle IMAP.', { code: err?.code });
    throw err;
  } finally {
    try {
      await client.logout();
    } catch {}
    isRunning = false;
  }
}

export async function checkMailboxHealth(): Promise<{ status: string; totalMessages: number; host: string }> {
  const cfg = loadConfig();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    tls: { rejectUnauthorized: true },
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  try {
    await client.connect();
    const status = await client.status('INBOX', { messages: true });
    return {
      status: 'healthy',
      totalMessages: status.messages ?? 0,
      host: cfg.host,
    };
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

export function scheduleImapCleanupInterval(): void {
  if (process.env.USE_EXTERNAL_CRON === "true") {
    console.log('[cleanup] Cron externe actif (USE_EXTERNAL_CRON=true), setInterval in-process dÃƒÂ©sactivÃƒÂ©.');
    return;
  }
  const oneHourMs = 60 * 60 * 1000;
  setInterval(() => {
    runCleanupCycle().catch((e) => console.error('[cleanup] Erreur intervalle non gÃƒÂ©rÃƒÂ©e :', e));
  }, oneHourMs);
  console.log('[cleanup] Nettoyage IMAP planifiÃƒÂ© toutes les heures.');
}
