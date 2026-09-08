import type { OpsMaxxApi } from './index'

declare global {
  interface Window {
    opsmaxx: OpsMaxxApi
  }
}

export {}
