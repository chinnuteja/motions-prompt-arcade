import { useReducer } from 'react';

export type GameStatus = 'SETUP' | 'COUNTDOWN' | 'PLAYING' | 'GAME_OVER';

export interface GameState {
  status: GameStatus;
  score: number;
  timeLeft: number;
  countdown: number;
}

export type Action =
  | { type: "START_COUNTDOWN" }
  | { type: "TICK_COUNTDOWN"; newCount: number }
  | { type: "START_PLAYING"; initialTime: number }
  | { type: "TICK_TIME"; timeLeft: number }
  | { type: "INCREMENT_SCORE"; amount?: number }
  | { type: "SET_SCORE"; score: number }
  | { type: "END_GAME" }
  | { type: "RESET" };

function gameReducer(state: GameState, action: Action): GameState {
  switch (action.type) {
    case "START_COUNTDOWN":
      return { ...state, status: "COUNTDOWN", countdown: 3, score: 0 };
    case "TICK_COUNTDOWN":
      return { ...state, countdown: action.newCount };
    case "START_PLAYING":
      return { ...state, status: "PLAYING", timeLeft: action.initialTime };
    case "TICK_TIME":
      if (state.status !== "PLAYING") return state;
      if (action.timeLeft <= 0) {
          return { ...state, timeLeft: 0, status: "GAME_OVER" };
      }
      return { ...state, timeLeft: action.timeLeft };
    case "INCREMENT_SCORE":
      if (state.status !== "PLAYING") return state;
      return { ...state, score: state.score + (action.amount ?? 1) };
    case "SET_SCORE":
      if (state.status !== "PLAYING") return state;
      return { ...state, score: action.score };
    case "END_GAME":
      return { ...state, status: "GAME_OVER", timeLeft: 0 };
    case "RESET":
      return { status: "SETUP", score: 0, timeLeft: 0, countdown: 3 };
    default:
      return state;
  }
}

export function useGameReducer() {
  return useReducer(gameReducer, {
    status: "SETUP",
    score: 0,
    timeLeft: 0,
    countdown: 3,
  });
}
