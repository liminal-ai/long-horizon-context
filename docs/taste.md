# Taste

Taste is powered by our meta neuro-symbolic AI model `taste-1` with continuous reinforcement learning (RL). We combine reasoning with neural intuition to create an invisible architecture of your choices, structures, patterns and tooling preferences.

![meta neuro-symbolic ai model taste-1](/docs/mns.png)

- **Continuously learning** side learns the texture of your code (explicit & implicit feedback).
- **Meta Neuro-Symbolic AI model `taste-1`** enforces the invisible logic of your choices.
- **Reflective Context Engineering** of a self-aware RL feedback loop to build skills.

✓ 10x faster coding, 2x faster code reviews, 5x fewer bugs.

---


## `taste-1`

The `taste-1` model is the core of our taste architecture. To build your taste profile it:

- Learns from you — every accept, reject, and edit becomes a signal
- Thinks like you — learns patterns and micro-decisions you'd never document
- Grows with you — a continuous learning loop that never goes stale

---

## How to get started

<Spoiler title="Install Command Code">
You can install Command Code by following these steps:

**Step 1: Install Command Code**

<CodeGroup title="">
```bash {{ title: 'npm' }}
npm i -g command-code
```
```bash {{ title: 'pnpm' }}
pnpm i -g command-code
```
```bash {{ title: 'yarn' }}
yarn global add command-code
```

**Step 2: Login to Command Code**

```bash
cmd login
```

**Step 3: Start coding with Command Code**

```bash
cmd
```

Unlike traditional coding assistants that rely on generic best practices, Taste builds a personalized model of your team's code review patterns, style preferences, and architectural choices. It observes how you write, review, and merge code to develop an intuitive understanding of your quality standards and design philosophy.

## Taste Sharing and Portability

The architecture of Taste is fundamentally built around the principle that taste should be transferable and composable. Your learned preferences aren't locked in a single project. They can be used across all your projects.

## Manage Taste with `npx taste`

Sharing and managing taste profiles is as simple as using Git. The `npx taste` CLI tool is your primary interface for pulling, pushing, and composing taste models which you can view in the [Command Code Studio](/studio/taste).

<CodeGroup title="Push project taste to remote">
```
npx taste push --all
```

This pushes your entire project's taste to `commandcode.ai/username/taste`.

```
npx taste pull username/project-name
```

This pulls taste from remote to your local project.

See the [taste commands reference](/taste/commands) for all available commands and options.

---

## Next steps

- Build something cool with Command Code and see your taste in action
- Join our [Discord community](https://commandcode.ai/discord) for feedback, requests, and support.