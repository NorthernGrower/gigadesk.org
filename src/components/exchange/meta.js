export const EXCHANGE_META = {
  binance_us: {
    name: 'Binance US',
    testnet: false,
    needsPassphrase: false,
    note: 'US-regulated venue on the same API surface as Binance — the market feed this desk already runs on.',
  },
  binance: {
    name: 'Binance',
    testnet: true,
    needsPassphrase: false,
    note: 'Global venue with a spot testnet for safe dry runs. Key access can be region-blocked.',
  },
  bybit: {
    name: 'Bybit',
    testnet: true,
    needsPassphrase: false,
    note: 'Large derivatives venue; unified account API with a testnet.',
  },
  kucoin: {
    name: 'KuCoin',
    testnet: false,
    needsPassphrase: true,
    note: 'Live keys only: KuCoin has retired its public sandbox. Needs the API passphrase in addition to the key and secret. Enable margin trading on the key to short through KuCoin — spot funds sit in the trading account and short collateral in the margin account.',
  },
  kraken: {
    name: 'Kraken',
    testnet: false,
    needsPassphrase: false,
    note: 'Create the key with "Query Funds" enabled — the desk reads balances with it.',
  },
};

export const EXCHANGE_ORDER = ['binance_us', 'binance', 'bybit', 'kucoin', 'kraken'];