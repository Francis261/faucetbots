#!/usr/bin/env node
import {
  addAccount, removeAccount, listAccounts, getAccountStats,
  markActive, resetAllAccounts
} from './accounts_db.mjs';

const args = process.argv.slice(2);
const cmd = args[0];

function usage() {
  console.log(`
Usage: node accounts.mjs <command> [options]

Commands:
  add <email> [url]          Add a new account
  remove <email>             Remove an account
  list                       List all accounts
  stats                      Show account statistics
  enable <email>             Re-enable a disabled account
  reset                      Reset all accounts to active

Examples:
  node accounts.mjs add user1@example.com
  node accounts.mjs add user2@example.com https://claimfreecoins.io/tether-faucet/
  node accounts.mjs remove user1@example.com
  node accounts.mjs list
  node accounts.mjs stats
  node accounts.mjs enable user1@example.com
  `);
}

if (!cmd || cmd === 'help') {
  usage();
  process.exit(0);
}

switch (cmd) {
  case 'add': {
    const email = args[1];
    if (!email) {
      console.error('Error: email required. Usage: node accounts.mjs add <email> [url]');
      process.exit(1);
    }
    const url = args[2];
    const added = addAccount(email, url);
    if (added) {
      console.log(`✓ Added: ${email}`);
    } else {
      console.log(`~ Already exists: ${email}`);
    }
    break;
  }

  case 'remove': {
    const email = args[1];
    if (!email) {
      console.error('Error: email required. Usage: node accounts.mjs remove <email>');
      process.exit(1);
    }
    const removed = removeAccount(email);
    if (removed) {
      console.log(`✓ Removed: ${email}`);
    } else {
      console.log(`~ Not found: ${email}`);
    }
    break;
  }

  case 'list': {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log('No accounts found.');
      break;
    }
    console.log(`\n${'ID'.padEnd(4)} ${'Email'.padEnd(35)} ${'Status'.padEnd(10)} ${'Claims'.padEnd(7)} Next Available`);
    console.log('-'.repeat(90));
    for (const a of accounts) {
      const next = a.next_available_at
        ? new Date(a.next_available_at).toLocaleString()
        : 'now';
      console.log(
        `${String(a.id).padEnd(4)} ${a.email.padEnd(35)} ${a.status.padEnd(10)} ${String(a.total_claims).padEnd(7)} ${next}`
      );
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
    const email = args[1];
    if (!email) {
      console.error('Error: email required. Usage: node accounts.mjs enable <email>');
      process.exit(1);
    }
    markActive(email);
    console.log(`✓ Enabled: ${email}`);
    break;
  }

  case 'reset': {
    resetAllAccounts();
    console.log('✓ All accounts reset to active');
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
}
