import { clusterApiUrl } from '@solana/web3.js'
import { Cluster } from '@/components/cluster/cluster'
import { ClusterNetwork } from '@/components/cluster/cluster-network'

export class AppConfig {
  static name = 'OnePhone'
  static uri = ''
  static clusters: Cluster[] = [
    {
      id: 'solana:mainnet',
      name: 'Mainnet',
      endpoint: process.env.EXPO_PUBLIC_SOLANA_RPC_URL || clusterApiUrl('mainnet-beta'),
      network: ClusterNetwork.Mainnet,
    },
  ]
}
