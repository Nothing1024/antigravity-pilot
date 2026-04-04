const mutationTails = new Map<string, Promise<void>>();

/**
 * Serialize conversation-scoped mutations so proxy-observed send order matches
 * the order in which the LS sees them.
 */
export async function runConversationMutation<T>(
  cascadeId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(cascadeId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  mutationTails.set(cascadeId, tail);

  await previous.catch(() => undefined);

  try {
    return await task();
  } finally {
    release();
    if (mutationTails.get(cascadeId) === tail) {
      mutationTails.delete(cascadeId);
    }
  }
}
