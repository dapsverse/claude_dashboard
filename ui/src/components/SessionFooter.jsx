const money = (usd) => (typeof usd === 'number' ? `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}` : null);

const int = (n) => (typeof n === 'number' ? n.toLocaleString() : null);

// The SDK reports usage in four buckets and every one of them is context the model actually read or
// wrote. Summing them is the closest honest answer to "how much context is this conversation using";
// it is labelled as tokens rather than as a percentage, because nothing in the payload states the
// window size and a made-up denominator would be worse than no number.
function contextTokens(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const total = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
    .reduce((sum, key) => sum + (typeof usage[key] === 'number' ? usage[key] : 0), 0);
  return total > 0 ? total : null;
}

// Every row is conditional. A session restored from history knows its cost and its id but not its
// model or turn count — those only ever arrive on a live `ready` or `result` — and a row of "—"
// placeholders reads as a broken footer rather than as an unreported value.
export function SessionFooter({ state }) {
  const { result, model, sessionId, permissionMode } = state;
  const tokens = contextTokens(result?.usage);
  const cost = money(result?.totalCostUsd);
  const turns = int(result?.numTurns);
  const known = model || cost || turns || tokens !== null || permissionMode || sessionId;

  return (
    <footer className="session-footer">
      {known
        ? (
          <dl>
            {model && <><dt>model</dt><dd className="mono">{model}</dd></>}
            {/* Cumulative for the session: this is the latest figure the daemon reported, never a sum
                of the ones before it. */}
            {cost && <><dt>cost</dt><dd className="mono" title="Cumulative for this session">{cost}</dd></>}
            {turns && <><dt>turns</dt><dd className="mono">{turns}</dd></>}
            {tokens !== null && <><dt>context</dt><dd className="mono">{int(tokens)} tok</dd></>}
            {permissionMode && <><dt>permissions</dt><dd className="mono">{permissionMode}</dd></>}
            {sessionId && <><dt>session</dt><dd className="mono session-id" title={sessionId}>{sessionId}</dd></>}
            {/* The transcript no longer repeats an error whose text the last answer already carried,
                so this is what says that the turn failed. */}
            {result?.isError && <><dt>last turn</dt><dd className="failed">failed</dd></>}
          </dl>
        )
        : <p className="empty">No session yet — the first message starts one.</p>}
    </footer>
  );
}
