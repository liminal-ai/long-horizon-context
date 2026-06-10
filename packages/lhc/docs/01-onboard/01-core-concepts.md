# Long Horizon Context: Core Concepts

Long Horizon Context (LHC) is a CLI and SDK for managing an agentic harness's context and history. It keeps the full message history of a conversation as a durable record, and from that record builds shorter, summarized views that a harness can load and work from.

## Basics

LHC is a stateless API: an SDK with a thin CLI over it. Each call takes what it needs, such as a thread id, a file path, or an input file, and operates on durable storage, so nothing is held open between calls. Agents can drive the CLI directly, and TypeScript apps can consume the SDK. A future app server can expose the same operations as endpoints.

The system is organized into domains, each owning one part of the conversation model and exposing its operations through the SDK and CLI. Beneath them sit a few shared tech utils, such as a durable work queue for background derivation and a token counter, that the domains use but that have no surface of their own.

## Key domains and entities

**Threads.** A thread is the durable container for one ongoing conversation between a user and an agentic harness, and each thread lives in its own file. The `threads` domain creates threads, keeps a catalog of which threads exist and where their files are, and holds thread-level metadata and status.

**Intake stream.** As a harness runs, it produces a stream of events: user prompts, assistant text and thinking, tool calls and their results, runtime notes, and a marker at the end of each turn. The `intake-stream` domain takes these events in ordered batches and records them into the thread. As it records the stream, it calls `messages` to create the readable message-and-block view and calls `turns` to open or close turn state.

**Messages.** A message is one unit of the conversation, such as a user prompt, an assistant response, or a tool result, built from blocks of text, thinking, tool calls, tool results, images, or files. The `messages` domain owns this message-and-block view. It creates messages when called by intake-stream, lets you read, list, and search them, and gives people or agents a place to edit or prune the message history directly.

**Turns.** A turn is one full exchange: a user prompt and all the assistant and tool activity that follows it, up to a `turn_end` or the next prompt. The `turns` domain owns turn state, derives closed turns, and groups turns into chunks that feed summaries and recall. Turns are the base unit; chunks are containers of turns.

**Thread views.** A thread view is a summarized, harness-ready rendering of a thread, produced by a smart compact and arranged so an agent can resume the conversation without the full history. The `thread-view` domain generates these views, keeps them current as new events arrive, and lets them be inspected, customized, and written into a provider's file format. A harness either loads a view LHC has written or pulls the current view from LHC directly.

**Inspect.** The `inspect` domain looks at a thread as a whole, producing overviews, statistics, and reports across its messages, turns, and views. It reads and explains; it does not change the record. Where `messages` works inside the history, `inspect` reports on the state of it.
