import {
  Connection,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { Wallet } from '@/utils/wallet'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { mnemonicToSeedSync } from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { sha256 } from 'js-sha256'

export type Token = {
  symbol: string
  balance?: number
  icon: JSX.Element
  mintAddress: string
}

export type TokenWithPrice = Token & {
  usdPrice?: number
}

type BinancePrice = {
  symbol: string
  price: string
}

async function fetchTokenPrices(symbols: string[]): Promise<Record<string, number>> {
  const binanceSymbols: Record<string, string> = {
    SOL: 'SOLUSDT',
    BONK: 'BONKUSDT'
  }

  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price')
    if (!response.ok) {
      throw new Error('Failed to fetch prices')
    }

    const data: BinancePrice[] = await response.json()

    const prices: Record<string, number> = {}
    symbols.forEach((symbol) => {
      prices[symbol] = 0
    })

    symbols.forEach((symbol) => {
      if (symbol === 'USDC') {
        prices[symbol] = 1 // USDC is always $1
        return
      }
      if ((symbol = 'SOL')) {
        console.log('SOL Price', prices[symbol])
      }

      const binanceSymbol = binanceSymbols[symbol]
      if (binanceSymbol) {
        const price = data.find((p) => p.symbol === binanceSymbol)
        if (price) {
          prices[symbol] = parseFloat(price.price)
        }
      }
    })

    return prices
  } catch (error) {
    console.error('Error fetching token prices:', error)
    return symbols.reduce(
      (acc, symbol) => ({
        ...acc,
        [symbol]: symbol === 'USDC' ? 1 : 0
      }),
      {}
    )
  }
}

const PRICE_CACHE_DURATION = 30000 // 30 seconds

let priceCache: Record<string, number> = {}
let lastPriceFetch = 0

export const fetchTokenBalances = async (
  connection: Connection,
  walletPublicKey: string,
  tokenList: Omit<Token, 'balance'>[]
): Promise<TokenWithPrice[]> => {
  const userPublicKey = new PublicKey(walletPublicKey)

  const balances = await Promise.all(
    tokenList.map(async (token) => {
      if (token.symbol === 'SOL') {
        const balance = await connection.getBalance(userPublicKey)
        return { ...token, balance: balance / LAMPORTS_PER_SOL }
      } else {
        const mintPublicKey = new PublicKey(token.mintAddress)
        const tokenAccount = await getAssociatedTokenAddress(mintPublicKey, userPublicKey)
        try {
          let accountInfo
          try {
            accountInfo = await getAccount(connection, tokenAccount)
          } catch (error) {
            if (error instanceof Error && error.message.includes('could not find account')) {
              const transaction = new Transaction().add(
                createAssociatedTokenAccountInstruction(
                  userPublicKey,
                  tokenAccount,
                  userPublicKey,
                  mintPublicKey
                )
              )
              const signature = await sendTransaction(transaction, connection, walletPublicKey)
              await connection.confirmTransaction(signature, 'confirmed')
              accountInfo = await getAccount(connection, tokenAccount)
            } else {
              throw error
            }
          }
          return {
            ...token,
            balance: Number(accountInfo.amount) / 1e6
          }
        } catch (error) {
          console.error(`Error fetching balance for ${token.symbol}:`, error)
          return { ...token, balance: 0 }
        }
      }
    })
  )

  // Check if we need to refresh prices
  const now = Date.now()
  if (now - lastPriceFetch > PRICE_CACHE_DURATION) {
    priceCache = await fetchTokenPrices(tokenList.map((t) => t.symbol))
    lastPriceFetch = now
  }

  return balances.map((token) => ({
    ...token,
    usdPrice: priceCache[token.symbol]
  }))
}

export const sendTokens = async (
  connection: Connection,
  wallet: Wallet,
  selectedToken: Token,
  sendAmount: string,
  recipient: string
): Promise<string> => {
  if (selectedToken.symbol === 'SOL') {
    const balance = await connection.getBalance(new PublicKey(wallet.publicKey))
    selectedToken.balance = balance / LAMPORTS_PER_SOL
    if (selectedToken.balance === undefined) {
      throw new Error('Insufficient SOL balance for this transfer')
    }
    const recipientPubkey = new PublicKey(recipient)
    const lamports = parseFloat(sendAmount) * LAMPORTS_PER_SOL

    if (lamports > selectedToken.balance * LAMPORTS_PER_SOL) {
      throw new Error('Insufficient SOL balance for this transfer')
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(wallet.publicKey),
        toPubkey: recipientPubkey,
        lamports
      })
    )
    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = new PublicKey(wallet.publicKey)
    const signedTransaction = await signTransaction(transaction, wallet)
    const signature = await connection.sendRawTransaction(signedTransaction.serialize())
    await connection.confirmTransaction(signature, 'confirmed')
    console.log(signature)
    return signature
  } else {
    const recipientPubkey = new PublicKey(recipient)
    const amountInDecimals = parseFloat(sendAmount) * 10 ** 6
    if (selectedToken.balance) {
      if (amountInDecimals > selectedToken.balance * 1e6) {
        throw new Error(`Insufficient ${selectedToken.symbol} balance for this transfer`)
      }
    }

    const fromPubkey = new PublicKey(wallet.publicKey)
    const mintPubkey = new PublicKey(selectedToken.mintAddress)

    const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey)
    const toTokenAccount = await getAssociatedTokenAddress(mintPubkey, recipientPubkey)

    let transaction = new Transaction()

    // Check if the sender's token account exists
    const fromTokenAccountInfo = await connection.getAccountInfo(fromTokenAccount)
    if (!fromTokenAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          fromTokenAccount,
          fromPubkey,
          mintPubkey
        )
      )
    }

    // Check if the recipient's token account exists
    const toTokenAccountInfo = await connection.getAccountInfo(toTokenAccount)
    if (!toTokenAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          toTokenAccount,
          recipientPubkey,
          mintPubkey
        )
      )
    }

    // Add transfer instruction
    transaction.add(
      createTransferInstruction(
        fromTokenAccount,
        toTokenAccount,
        fromPubkey,
        BigInt(amountInDecimals),
        [],
        TOKEN_PROGRAM_ID
      )
    )

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = fromPubkey

    // Sign and send transaction
    const signedTransaction = await signTransaction(transaction, wallet)
    const signature = await connection.sendRawTransaction(signedTransaction.serialize())
    await connection.confirmTransaction(signature, 'confirmed')

    return signature
  }
}

const signTransaction = async (transaction: Transaction, wallet: Wallet): Promise<Transaction> => {
  const message = transaction.serializeMessage()
  const secretKey = bs58.decode(wallet.privateKey)
  const signature = nacl.sign.detached(message, secretKey)
  transaction.addSignature(new PublicKey(wallet.publicKey), Buffer.from(signature))
  return transaction
}

const sendTransaction = async (
  transaction: Transaction,
  connection: Connection,
  walletPublicKey: string
): Promise<string> => {
  const { blockhash } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = new PublicKey(walletPublicKey)
  const rawTransaction = transaction.serialize()
  const signature = await connection.sendRawTransaction(rawTransaction)
  return signature
}

export const withdrawToExternalWallet = async (
  connection: Connection,
  wallet: Wallet,
  selectedToken: Token,
  sendAmount: string,
  recipient: string
): Promise<string> => {
  return sendTokens(connection, wallet, selectedToken, sendAmount, recipient)
}

export const retrieveMnemonic = (): string => {
  const wallet = localStorage.getItem('Solana_wallet')
  if (!wallet) {
    throw new Error('No wallet found')
  }
  const walletParsed = JSON.parse(wallet)
  const mnemonic = walletParsed.mnemonic
  return mnemonic
}

export const deleteMnemonic = (): void => {
  const wallet = localStorage.getItem('Solana_wallet')
  if (!wallet) {
    throw new Error('No wallet found')
  }
  const walletParsed = JSON.parse(wallet)
  walletParsed.mnemonic = ''
  localStorage.setItem('Solana_wallet', JSON.stringify(walletParsed))
}

export const hasMnemonic = (): boolean => {
  const wallet = localStorage.getItem('Solana_wallet')
  if (!wallet) {
    return false
  }
  const walletParsed = JSON.parse(wallet)
  return walletParsed.mnemonic !== ''
}

type EscrowParams = {
  connection: Connection
  wallet: Wallet
  amount: string
  expirationTime: number
  secret: string
  token?: Token
}

class EscrowError extends Error {
  constructor(
    message: string,
    public logs?: string[]
  ) {
    super(message)
    this.name = 'EscrowError'
  }
}

function getInstructionDiscriminator(name: string): Buffer {
  const preimage = `global:${name}`
  return Buffer.from(sha256.array(preimage).slice(0, 8))
}

async function createEscrowInstruction(
  params: EscrowParams,
  escrowAccount: PublicKey,
  isSol: boolean
): Promise<TransactionInstruction> {
  const { wallet, amount, expirationTime, secret, token } = params
  const fromPubkey = new PublicKey(wallet.publicKey)
  const secretHash = Array.from(sha256.array(secret))
  const programId = new PublicKey('BCLTR5fuCWrMUWc75yKnG35mtrvXt6t2eLuPwCXA93oY')

  const amountInSmallestUnit = isSol
    ? Math.round(parseFloat(amount) * LAMPORTS_PER_SOL)
    : Math.round(parseFloat(amount) * 1e6)

  // Calculate discriminators using Anchor's method
  const SPL_DISCRIMINATOR = getInstructionDiscriminator('initialize_transfer_spl')
  const SOL_DISCRIMINATOR = getInstructionDiscriminator('initialize_transfer_sol')

  if (!isSol && token) {
    const mintPubkey = new PublicKey(token.mintAddress)
    const escrowTokenAccount = await getAssociatedTokenAddress(mintPubkey, escrowAccount, true)
    const senderTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey)

    return new TransactionInstruction({
      keys: [
        { pubkey: fromPubkey, isSigner: true, isWritable: true },
        { pubkey: escrowAccount, isSigner: false, isWritable: true },
        { pubkey: escrowTokenAccount, isSigner: false, isWritable: true },
        { pubkey: senderTokenAccount, isSigner: false, isWritable: true },
        { pubkey: mintPubkey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      programId,
      data: Buffer.concat([
        SPL_DISCRIMINATOR,
        Buffer.from(new BigInt64Array([BigInt(amountInSmallestUnit)]).buffer),
        Buffer.from(new BigInt64Array([BigInt(expirationTime)]).buffer),
        Buffer.from(secretHash)
      ])
    })
  }

  // For SOL transfers
  return new TransactionInstruction({
    keys: [
      { pubkey: fromPubkey, isSigner: true, isWritable: true },
      { pubkey: escrowAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
    ],
    programId,
    data: Buffer.concat([
      SOL_DISCRIMINATOR,
      Buffer.from(new BigInt64Array([BigInt(amountInSmallestUnit)]).buffer),
      Buffer.from(new BigInt64Array([BigInt(expirationTime)]).buffer),
      Buffer.from(secretHash)
    ])
  })
}

export async function initializeEscrow(params: EscrowParams): Promise<string> {
  const { connection, wallet, secret, token } = params
  const isSol = !token
  const escrowSeed = isSol ? 'escrow_sol' : 'escrow_spl'
  const secretHash = Array.from(sha256.array(secret))
  console.log('secretHash', sha256(secret))

  try {
    const [escrowAccount] = await PublicKey.findProgramAddress(
      [Buffer.from(escrowSeed), Buffer.from(secretHash)],
      new PublicKey('BCLTR5fuCWrMUWc75yKnG35mtrvXt6t2eLuPwCXA93oY')
    )

    const transaction = new Transaction()
    transaction.add(await createEscrowInstruction(params, escrowAccount, isSol))

    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = new PublicKey(wallet.publicKey)

    const signedTransaction = await signTransaction(transaction, wallet)

    try {
      // Simulate the transaction first
      const simulation = await connection.simulateTransaction(signedTransaction)
      if (simulation.value.err) {
        throw new EscrowError('Transaction simulation failed', simulation.value.logs)
      }

      const signature = await connection.sendRawTransaction(signedTransaction.serialize())
      await connection.confirmTransaction(signature, 'confirmed')
      return signature
    } catch (error) {
      if (error instanceof Error) {
        const sendError = error as any
        if (sendError.logs) {
          throw new EscrowError(`Failed to initialize escrow: ${error.message}`, sendError.logs)
        }
      }
      throw error
    }
  } catch (error) {
    console.error('Escrow initialization error:', error)
    if (error instanceof EscrowError) {
      console.error('Program logs:', error.logs)
    }
    throw error
  }
}

type RedeemParams = {
  connection: Connection
  wallet: Wallet
  secret: string
  isSol: boolean
  token?: Token
  recipient?: string // Optional recipient address, defaults to signer
}

export async function redeemEscrow(params: RedeemParams): Promise<string> {
  const { connection, wallet, secret, isSol, token } = params
  const secretHash = Array.from(sha256.array(secret))
  const escrowSeed = isSol ? 'escrow_sol' : 'escrow_spl'

  try {
    const [escrowAccount] = await PublicKey.findProgramAddress(
      [Buffer.from(escrowSeed), Buffer.from(secretHash)],
      new PublicKey('BCLTR5fuCWrMUWc75yKnG35mtrvXt6t2eLuPwCXA93oY')
    )

    const transaction = new Transaction()
    transaction.add(await createRedeemInstruction(params, escrowAccount))

    const { blockhash } = await connection.getLatestBlockhash()
    transaction.recentBlockhash = blockhash
    transaction.feePayer = new PublicKey(wallet.publicKey)

    const signedTransaction = await signTransaction(transaction, wallet)
    const signature = await connection.sendRawTransaction(signedTransaction.serialize())
    await connection.confirmTransaction(signature, 'confirmed')
    return signature
  } catch (error) {
    console.error('Redeem error:', error)
    if (error instanceof EscrowError) {
      console.error('Program logs:', error.logs)
    }
    throw error
  }
}

async function createRedeemInstruction(
  params: RedeemParams,
  escrowAccount: PublicKey
): Promise<TransactionInstruction> {
  const { wallet, secret, isSol, token, recipient } = params
  const fromPubkey = new PublicKey(wallet.publicKey)
  const programId = new PublicKey('BCLTR5fuCWrMUWc75yKnG35mtrvXt6t2eLuPwCXA93oY')

  // Calculate redeem discriminator
  const REDEEM_DISCRIMINATOR = getInstructionDiscriminator(
    isSol ? 'redeem_funds_sol' : 'redeem_funds_spl'
  )

  if (!isSol && token) {
    const mintPubkey = new PublicKey(token.mintAddress)
    const escrowTokenAccount = await getAssociatedTokenAddress(mintPubkey, escrowAccount, true)
    const recipientTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey)

    return new TransactionInstruction({
      keys: [
        { pubkey: fromPubkey, isSigner: true, isWritable: true }, // signer
        { pubkey: fromPubkey, isSigner: false, isWritable: true }, // recipient
        { pubkey: escrowAccount, isSigner: false, isWritable: true }, // escrow_account
        { pubkey: escrowTokenAccount, isSigner: false, isWritable: true }, // escrow_token_account
        { pubkey: recipientTokenAccount, isSigner: false, isWritable: true }, // recipient_token_account
        { pubkey: mintPubkey, isSigner: false, isWritable: false }, // token_mint
        { pubkey: fromPubkey, isSigner: false, isWritable: true }, // sender
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      programId,
      data: Buffer.concat([REDEEM_DISCRIMINATOR, Buffer.from(secret, 'utf8')])
    })
  }

  return new TransactionInstruction({
    keys: [
      { pubkey: fromPubkey, isSigner: true, isWritable: true }, // signer
      { pubkey: fromPubkey, isSigner: false, isWritable: true }, // recipient
      { pubkey: escrowAccount, isSigner: false, isWritable: true }, // escrow_account
      { pubkey: fromPubkey, isSigner: false, isWritable: true }, // sender
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
    ],
    programId,
    data: Buffer.concat([REDEEM_DISCRIMINATOR, Buffer.from(secret, 'utf8')])
  })
}
