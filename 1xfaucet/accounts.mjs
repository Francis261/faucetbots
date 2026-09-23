#!/usr/bin/env node
import { addAccount, removeAccount, listAccounts, getAccountStats, markActive, resetAll } from './accounts_db.mjs';

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === 'help') {
  console.log(`
Usage: node accounts.mjs <command> [options]

Commands:
  add <email> <password>    Add account
  remove <email>            Remove account
  list                      List all accounts
  stats                     Show statistics
  enable <email>            Re-enable account
  reset                     Reset all to active
  `);
  process.exit(0);
}

switch (cmd) {
  case 'add': {
    const [email, password] = [args[1], args[2]];
    if (!email || !password) { console.error('Usage: node accounts.mjs add <email> <password>'); process.exit(1); }
    console.log(addAccount(email, password) ? `✓ Added: ${email}` : `~ Exists: ${email}`);
    break;
  }
  case 'remove': {
    if (!args[1]) { console.error('Usage: node accounts.mjs remove <email>'); process.exit(1); }
    console.log(removeAccount(args[1]) ? `✓ Removed: ${args[1]}` : `~ Not found: ${args[1]}`);
    break;
  }
  case 'list': {
    const accounts = listAccounts();
    if (!accounts.length) { console.log('No accounts.'); break; }
    console.log(`\n${'ID'.padEnd(4)} ${'Email'.padEnd(30)} ${'Status'.padEnd(10)} ${'Claims'.padEnd(7)} Next Available`);
    console.log('-'.repeat(85));
    for (const a of accounts) {
      const next = a.next_available_at ? new Date(a.next_available_at).toLocaleString() : 'now';
      console.log(`${String(a.id).padEnd(4)} ${a.email.padEnd(30)} ${a.status.padEnd(10)} ${String(a.total_claims).padEnd(7)} ${next}`);
    }
    console.log();
    break;
  }
  case 'stats': {
    const s = getAccountStats();
    console.log(`\nAccounts: ${s.total} total, ${s.active} active, ${s.cooldown} cooldown, ${s.errors} errors`);
    console.log(`Total claims: ${s.totalClaims}\n`);
    break;
  }
  case 'enable': {
    if (!args[1]) { console.error('Usage: node accounts.mjs enable <email>'); process.exit(1); }
    markActive(args[1]);
    console.log(`✓ Enabled: ${args[1]}`);
    break;
  }
  case 'reset': {
    resetAll();
    console.log('✓ All accounts reset to active');
    break;
  }
  default:
    console.error(`Unknown command: ${cmd}`);
    process.exit(1);
}
