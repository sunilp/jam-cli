# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in Jam CLI, please report it responsibly:

### How to Report

1. **Email**: Send a detailed report to **prakashsunil@proton.me**
2. **Subject**: Use the prefix `[JAM-SECURITY]` in the subject line
3. **Encryption**: If you need to share sensitive details, ask for a PGP key in your initial email

### What to Include

- **Description** of the vulnerability
- **Steps to reproduce** (proof of concept if possible)
- **Impact assessment** — what an attacker could achieve
- **Affected versions**
- **Suggested fix** (if you have one)

### Response Timeline

| Action | Timeline |
|--------|----------|
| Acknowledgment of report | Within **48 hours** |
| Initial assessment | Within **5 business days** |
| Resolution target | Within **30 days** (varies by severity) |
| Public disclosure | After fix is released and users have time to update |

### What to Expect

1. We will acknowledge receipt of your report within 48 hours
2. We will work with you to understand and validate the issue
3. We will develop a fix and coordinate disclosure timing with you
4. We will credit you in the security advisory (unless you prefer anonymity)

### Safe Harbor

We support safe harbor for security researchers who:

- Make a good faith effort to avoid privacy violations, data destruction, and service disruption
- Only interact with accounts you own or with explicit permission
- Do not exploit a vulnerability beyond what is necessary to confirm it
- Report findings promptly and do not publicly disclose before a fix is available

We will not pursue legal action against researchers who follow these guidelines.

## Security Best Practices for Users

### API Keys & Secrets

- **Prefer the OS keychain** (`keytar`) for storing API keys — Jam will use it automatically
- If keytar is unavailable, use environment variables (`JAM_API_KEY`) rather than config files
- **Never commit** `.jam/config.json` files containing API keys
- Use `redactPatterns` in your config to prevent accidental logging of secrets

### Configuration

- Review tool permissions — set `toolPolicy` to `ask_every_time` (default) to confirm before write operations
- Be cautious with `toolPolicy: "allowlist"` in shared environments
- Audit `.jam/config.json` before committing to version control

### Network Security

- Ollama runs locally by default (`localhost:11434`) — no data leaves your machine
- If connecting to remote providers, ensure you're using HTTPS
- Review the model's tool calls before confirming write operations

## Dependencies

We regularly audit dependencies for known vulnerabilities. If you notice a vulnerable dependency, please report it through the process above or open a standard issue.
