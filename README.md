# Private Expense

Shared expenses between two people: add an expense, pick who paid, every
expense is split 50/50, and a running balance shows who owes whom. Tap
**Settle up** when you pay each other back (e.g. every Friday); the balance
resets and the week moves to History.

- Names and currency are set in the app on first use (nothing is hard-coded).
- **This repo contains only the app code: no names, no data, no keys.**
- Data lives in a separate **private** GitHub repo as `data.json`, read and
  written through GitHub's API with a fine-grained access key that can only
  touch that one repo.
- Each phone keeps a local copy, so it works offline and syncs when back
  online. Edits from both phones are merged; nothing is overwritten.
- Clearing the browser loses nothing: reopen the setup link.

The setup link contains the access key, so share it only privately. If it
leaks, delete the key on GitHub and create a new one.
