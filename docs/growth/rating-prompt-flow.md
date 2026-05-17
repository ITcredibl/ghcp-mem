# Rating Prompt Flow (Extension UI)

## Purpose
Increase high-quality Marketplace feedback without interrupting new users too early.

## Design Principles
- Ask only after value is demonstrated.
- Keep controls explicit and respectful.
- Enforce cooldown to avoid prompt fatigue.
- Never block core workflows.

## Trigger Model
Prompt eligibility is evaluated after successful user-driven actions:
- `GHCP-MEM: Capture Session Snapshot Now`
- `GHCP-MEM: Compress Current Session`
- `GHCP-MEM: Capture Azure Context Snapshot...`

## Eligibility Rules
A prompt can show only when all are true:
- successful outcomes count >= 3
- stored sessions >= 3
- user has not already rated
- user has not selected "Don't Ask Again"
- last prompt was more than 14 days ago

## User Choices
Prompt buttons:
- `Rate GHCP-MEM`
- `Later`
- `Don't Ask Again`

Behavior:
- `Rate GHCP-MEM`: opens Marketplace review page and marks user as rated.
- `Later`: records prompt timestamp and starts cooldown.
- `Don't Ask Again`: permanently suppresses future prompts.

## State Storage
Persistent state is stored in extension `globalState` under:
- `ghcpMem.reviewPromptState`

Fields:
- `successes`: number
- `rated`: boolean
- `doNotAskAgain`: boolean
- `lastPromptAt`: epoch millis (optional)

## UX Copy
Current message:
- "Is GHCP-MEM helping your workflow? A Marketplace rating helps more developers discover it."

Tone goals:
- gratitude, not pressure
- clear user control
- short and actionable

## Guardrails
- Single in-flight prompt at a time.
- No prompts during startup.
- No prompts during autosave-only background cycles.

## Suggested Metrics
- Prompt shown count
- Click rate on `Rate GHCP-MEM`
- Dismiss rate (`Later`)
- Opt-out rate (`Don't Ask Again`)
- Rating conversion per 100 eligible users

## Future Improvements
- Add configurable thresholds via settings (for A/B tuning).
- Local telemetry aggregate export (opt-in, privacy-preserving).
- Contextual copy variants by user persona (enterprise/solo/open-source).
