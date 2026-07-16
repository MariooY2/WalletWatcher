import { JsonRpcProvider, Network } from "ethers";
import { SEPOLIA_CHAIN_ID } from "./config.js";

/**
 * Create a JSON-RPC provider pinned to Sepolia.
 *
 * Pinning the network (staticNetwork) avoids an extra eth_chainId round-trip per
 * request and guards against accidentally talking to a non-Sepolia endpoint.
 */
export function createProvider(rpcUrl: string): JsonRpcProvider {
  const network = Network.from(Number(SEPOLIA_CHAIN_ID));
  return new JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
}
