const sourceMapsProcess = process as typeof process & {
  setSourceMapsEnabled?: (enabled: boolean) => void;
};

sourceMapsProcess.setSourceMapsEnabled?.(true);
