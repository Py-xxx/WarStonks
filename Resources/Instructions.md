# AI Initial Instructions

These instructions must be read and followed first on every prompt.

1. Always refer to the `/Resources` folder first on every prompt before deciding how to proceed.
2. Treat the `/Resources` folder as a required source of truth because it contains API docs, integration examples, and examples of exact API request outputs.
3. `Database_Rules.md` rules MUST be followed whenever there is any kind of database interaction.
4. Never hard-code values or behavior directly into UI elements.
5. Implement logic in functions, and have UI elements (for example, buttons) call those functions.
6. Do not create multiple functions that do the same thing.
7. Reuse existing functions when they fit the need and can be adapted safely without introducing errors or reducing efficiency.
8. Use a single source of truth for configurable values (constants/config), and avoid duplicated literals.
9. Validate all inputs before processing, and fail safely with clear error messages.
10. Separate pure logic from side effects such as UI updates, file I/O, and API calls.
11. Write or update tests for any new calculation or critical logic change.
12. Do not silently ignore errors; handle and surface them explicitly.
13. Keep functions small, single-purpose, and clearly named.
14. Preserve backward compatibility unless a breaking change is explicitly approved.
15. Document assumptions, limits, and known unknowns in comments or implementation notes.
16. Never invent or fabricate content to satisfy a request.
17. If something is not possible, state that clearly and do not proceed as if it is possible.
18. If there is any uncertainty, ask clarifying questions before making assumptions.
19. All calculations must be logically sound and produce accurate, reliable results.
20. After every major addition or edit, commit the changes to Git with a clear commit message and push to GitHub.
21. Any Warframe Market API request must go through the shared priority queue / scheduler rather than calling the API directly.
