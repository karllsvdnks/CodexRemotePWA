const args = process.argv.slice(2);
const resumeIndex = args.indexOf("resume");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : "fixture-session-001";
const prompt = args.at(-1) || "";

process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: sessionId })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: `message-${Date.now()}`, type: "agent_message", text: `${resumeIndex >= 0 ? "resumed" : "started"}: ${prompt}` } })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);

// Exercise the server's completion event handling independently of process exit.
await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
