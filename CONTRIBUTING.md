# Contributing to Jam CLI

First off — **thank you** for considering a contribution to Jam! Every bug report, feature request, documentation fix, and code change makes this project better for everyone.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Security Vulnerabilities](#security-vulnerabilities)

---

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to **prakashsunil@proton.me**.

---

## How Can I Contribute?

| Type | Description |
|------|-------------|
| 🐛 Bug Reports | Found a bug? Open an issue with reproduction steps |
| 💡 Feature Requests | Have an idea? Open an issue to discuss it first |
| 📖 Documentation | Fix typos, improve explanations, add examples |
| 🧪 Tests | Add missing tests or improve existing ones |
| 🔧 Code | Fix bugs, implement features, refactor code |
| 🌍 Providers | Add support for new LLM providers |
| 🛠 Tools | Create new model-callable tools for `jam run` |

---

## Getting Started

### Prerequisites

- **Node.js 20+** (check with `node --version`)
- **[Ollama](https://ollama.ai)** running locally for integration testing
- **Git** (obviously 😄)

### Fork & Clone

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<your-username>/jam-cli.git
cd jam-cli
npm install
```

### Verify Your Setup

```bash
npm run build       # Compile TypeScript
npm test            # Run unit tests
npm run typecheck   # Type-check without emitting
npm run lint        # Lint with ESLint
```

All four commands should pass before you start making changes.

---

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feat/my-new-feature    # for features
git checkout -b fix/describe-the-bug   # for bug fixes
git checkout -b docs/what-you-changed  # for docs
```

### 2. Make Your Changes

```bash
# Run from source during development
npm run dev -- ask "Does this work?"

# Run tests in watch mode
npm run test:watch
```

### 3. Test Your Changes

```bash
npm test                  # All tests must pass
npm run typecheck         # No type errors
npm run lint              # No lint errors
npm run test:coverage     # Check coverage isn't regressed
```

### 4. Commit & Push

```bash
git add .
git commit -m "feat: add support for Anthropic provider"
git push origin feat/my-new-feature
```

### 5. Open a Pull Request

Head to GitHub and open a PR against the `main` branch.

---

## Pull Request Process

1. **Fill out the PR template** — it exists for a reason
2. **Keep PRs focused** — one feature or fix per PR
3. **Add tests** — new features require tests; bug fixes should add a regression test
4. **Update documentation** — if you changed behavior, update the README or relevant docs
5. **Ensure CI passes** — all checks must be green before review
6. **Be responsive** — address review feedback promptly
7. **Squash if needed** — we may ask you to squash commits for a clean history

### PR Review Checklist

- [ ] Tests pass locally (`npm test`)
- [ ] Type-check passes (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] Documentation updated (if applicable)
- [ ] No secrets, credentials, or personal data in the diff
- [ ] Commit messages follow convention (see below)

---

## Coding Standards

### TypeScript Style

- **Strict TypeScript** — no `any` unless absolutely unavoidable (with a comment explaining why)
- **ESM modules** — use `.js` extensions in imports (TypeScript ESM requirement)
- **Explicit types** — prefer explicit return types on exported functions
- **Readonly where possible** — use `readonly` for properties that shouldn't change

### Formatting

We use **Prettier** for formatting. Run `npm run format` before committing or set up your editor to format on save.

```bash
npm run format    # Auto-format all source files
```

### Linting

ESLint is configured with TypeScript rules. Fix any warnings before submitting.

```bash
npm run lint      # Check for issues
```

### File Organization

- **One command per file** in `src/commands/`
- **One tool per file** in `src/tools/`
- **One provider per file** in `src/providers/`
- **Tests colocated** with source: `foo.ts` → `foo.test.ts`

---

## Commit Messages

We follow **[Conventional Commits](https://www.conventionalcommits.org/)**:

```
<type>(<optional scope>): <short description>

<optional body>

<optional footer>
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons, etc. (no logic change) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `chore` | Build process, CI, tooling changes |

### Examples

```
feat(providers): add Anthropic Claude provider
fix(tools): handle symlinks in read_file tool
docs: add contributing guide
test(config): add tests for profile merging
chore: update dependencies
```

---

## Reporting Bugs

Use the [Bug Report issue template](https://github.com/sunilp/jam-cli/issues/new?template=bug_report.md) and include:

1. **What you expected** to happen
2. **What actually happened** (include error messages, screenshots)
3. **Steps to reproduce** — the more specific, the better
4. **Environment** — OS, Node.js version, Ollama version, Jam version (`jam --version`)
5. **Configuration** — relevant parts of your `.jam/config.json` (redact secrets!)

---

## Suggesting Features

Use the [Feature Request issue template](https://github.com/sunilp/jam-cli/issues/new?template=feature_request.md) and include:

1. **Problem statement** — what pain point does this solve?
2. **Proposed solution** — how should it work?
3. **Alternatives considered** — what else did you think about?
4. **Context** — are you willing to implement this yourself?

> 💡 **Tip:** For large features, open an issue to discuss the approach _before_ writing code. This saves everyone time.

---

## Security Vulnerabilities

**Do NOT open a public issue for security vulnerabilities.**

Please report them responsibly via the process described in [SECURITY.md](SECURITY.md). We take security seriously and will respond promptly.

---

## Adding a New Provider

See the [Adding a New Provider](README.md#adding-a-new-provider) section in the README for the implementation pattern, then:

1. Create `src/providers/yourprovider.ts` implementing `ProviderAdapter`
2. Create `src/providers/yourprovider.test.ts` with unit tests
3. Register in `src/providers/factory.ts`
4. Update README with usage examples

## Adding a New Tool

1. Create `src/tools/your_tool.ts` implementing the `ToolDefinition` interface
2. Create `src/tools/your_tool.test.ts`
3. Register in `src/tools/index.ts`
4. Update README tool table

---

## License

By contributing to Jam CLI, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

**Thank you for helping make Jam better!** 🎉
