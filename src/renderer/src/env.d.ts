/// <reference types="vite/client" />
import type { OpsMaxxApi } from '../../preload/index'

declare global {
  interface Window {
    opsmaxx: OpsMaxxApi
  }
}

export {}
