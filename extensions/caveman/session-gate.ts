export interface CavemanSessionPersistenceContextLike {
  sessionManager: {
    isPersisted?: (() => unknown) | undefined;
    getSessionFile?: (() => unknown) | undefined;
  };
}

export function isTopLevelPersistedSession(
  ctx: CavemanSessionPersistenceContextLike,
): boolean {
  const persistedSignal = readPersistedSignal(ctx);
  const sessionFileSignal = readSessionFileSignal(ctx);

  if (persistedSignal !== undefined && sessionFileSignal !== undefined) {
    return persistedSignal === sessionFileSignal ? persistedSignal : false;
  }

  return persistedSignal ?? sessionFileSignal ?? false;
}

function readPersistedSignal(
  ctx: CavemanSessionPersistenceContextLike,
): boolean | undefined {
  if (typeof ctx.sessionManager.isPersisted !== "function") {
    return undefined;
  }

  const persisted = ctx.sessionManager.isPersisted();
  return typeof persisted === "boolean" ? persisted : undefined;
}

function readSessionFileSignal(
  ctx: CavemanSessionPersistenceContextLike,
): boolean | undefined {
  if (typeof ctx.sessionManager.getSessionFile !== "function") {
    return undefined;
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile == null) {
    return false;
  }

  if (typeof sessionFile !== "string") {
    return undefined;
  }

  return sessionFile.trim().length > 0;
}
