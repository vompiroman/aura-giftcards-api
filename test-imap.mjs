#!/usr/bin/env node
// Usage : node test-imap.mjs "monemail@outlook.fr" "mon-app-password"
// Teste la connexion IMAP en direct et affiche l'erreur exacte de Microsoft.

import { ImapFlow } from 'imapflow';

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error('❌ Usage : node test-imap.mjs "email@outlook.fr" "app-password"');
  process.exit(1);
}

const domain = email.toLowerCase().split('@')[1] || '';
const microsoft = ['outlook.fr', 'outlook.com', 'hotmail.fr', 'hotmail.com', 'live.fr', 'live.com', 'msn.com'];

const hosts = microsoft.includes(domain)
  ? ['outlook.office365.com', 'imap-mail.outlook.com']
  : domain === 'gmail.com'
    ? ['imap.gmail.com']
    : domain.startsWith('yahoo.')
      ? ['imap.mail.yahoo.com']
      : ['outlook.office365.com', 'imap-mail.outlook.com'];

async function testHost(host) {
  console.log(`\n🔌 Test de ${host}:993 (SSL) ...`);
  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    tls: { rejectUnauthorized: false },
    auth: { user: email, pass: password },
    logger: false,
    clientInfo: { name: 'AuraStream-Test', version: '1.0.0' },
  });

  try {
    await client.connect();
    console.log(`✅ Connexion & authentification RÉUSSIES sur ${host}`);

    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      console.log(`   📥 INBOX : ${status.messages} messages (${status.unseen} non lus)`);
    } finally {
      lock.release();
    }

    await client.logout();
    return true;
  } catch (err) {
    const raw = err.responseText || err.message || String(err);
    console.error(`❌ Échec sur ${host}`);
    console.error(`   Code    : ${err.responseStatus || err.code || 'N/A'}`);
    console.error(`   Serveur : ${raw}`);

    if (/AUTHENTICATIONFAILED/i.test(raw)) {
      console.error('   👉 Cause probable : mauvais mot de passe d\'application, ou IMAP non activé.');
    } else if (/disabled|not enabled/i.test(raw)) {
      console.error('   👉 Cause probable : IMAP désactivé côté Microsoft.');
    }
    try { await client.logout(); } catch {}
    return false;
  }
}

let ok = false;
for (const host of hosts) {
  ok = await testHost(host);
  if (ok) break;
}

console.log(ok ? '\n🎉 Au moins un hôte fonctionne.' : '\n💥 Tous les hôtes ont échoué (voir erreurs ci-dessus).');
process.exit(ok ? 0 : 1);
