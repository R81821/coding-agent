import React from "react";
import { RecycleBin } from "../../recycle-bin.js";

export function RecycleSettings({
  refreshHistory,
}: {
  refreshHistory: () => Promise<void>;
}) {
  return <RecycleBin onChanged={refreshHistory} />;
}
