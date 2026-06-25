# code-style
- Use explicit, self-documenting names for operations and parameters; avoid generic placeholders like "input", "request", "context", "workHandlers", "report", "forPrompt", or "Ops?" that obscure what the operation actually does. Confidence: 0.75
- When a function parameter is a ThreadRef type, name the parameter `threadRef`, not `thread`. Confidence: 0.60
- Use consistent CRUD naming across domain surfaces: `list`, `show`, `create`, `edit`, `remove`; avoid domain-specific alternatives like "applyEvent" for create or "deleteMessage" when "remove" is the standard. Confidence: 0.75
- When a function or method is difficult to name or describe clearly, it is doing too many things and should be decomposed into smaller, focused operations that each do one thing. Confidence: 0.70
- Avoid abbreviations like "Tx" and "Fn" in function, parameter, and type names unless they are universally accepted and normalized across codebases. Confidence: 0.70
- Prefer "operation" over "run" as a function/method name: "run" is overloaded and ambiguous, while "operation" is functionally descriptive and hard to confuse with unrelated concepts. Confidence: 0.65
