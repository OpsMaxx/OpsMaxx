import type { CloudProvider } from '../../../../shared/cloud'
import { awsBroker } from './aws'
import { azureBroker } from './azure'
import { gcpBroker } from './gcp'
import type { CloudBroker } from './types'

/** The one place a provider id becomes an implementation. */
export const BROKERS: Record<CloudProvider, CloudBroker> = {
  gcp: gcpBroker,
  aws: awsBroker,
  azure: azureBroker
}

export function brokerFor(provider: CloudProvider): CloudBroker {
  return BROKERS[provider]
}

export type { CloudBroker, PreparedCloudConnection } from './types'
