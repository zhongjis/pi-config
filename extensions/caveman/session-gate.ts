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
  const isPersisted = ctx.sessionManager.isPersisted;
  if (typeof isPersisted !== "function") {
    return undefined;
  }

  const persisted = isPersisted();
  return typeof persisted === "boolean" ? persisted : undefined;
}

function readSessionFileSignal(
  ctx: CavemanSessionPersistenceContextLike,
): boolean | undefined {
  const getSessionFile = ctx.sessionManager.getSessionFile;
  if (typeof getSessionFile !== "function") {
    return undefined;
  }

  const sessionFile = getSessionFile();
  if (sessionFile == null) {
    return false;
  }

  if (typeof sessionFile !== "string") {
    return undefined;
  }

  return sessionFile.trim().length > 0;
}
