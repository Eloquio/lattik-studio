"use client";

import { createContext, useContext } from "react";

interface CanvasActions {
  sendChatMessage: (text: string) => void;
}

const defaultActions: CanvasActions = {
  sendChatMessage: () => {},
};

export const CanvasActionsContext = createContext<CanvasActions>(defaultActions);

export function useCanvasActions() {
  return useContext(CanvasActionsContext);
}
