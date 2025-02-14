'use client'

import { useState, useEffect, useCallback } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, RefreshCcw, Send, X, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { initUtils } from '@telegram-apps/sdk'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { toast } from 'sonner'
import { useWallet } from '@/contexts/WalletContext'
import { tokenList } from '@/utils/tokens'
import { fetchTokenBalances, Token, initializeEscrow, fetchTokenPrices } from '@/utils/solanaUtils'
import { cn } from '@/lib/utils'
import { BN } from '@coral-xyz/anchor'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Contact = {
  id: string
  name: string
  solanaAddress?: string
}

type TokenBalancesProps = {
  contacts: Contact[]
  defaultToken?: string
}

type TokenWithPrice = Token & {
  usdPrice?: number
}

export default function TokenBalances({ contacts, defaultToken }: TokenBalancesProps) {
  const { walletSolana } = useWallet()
  const [connection, setConnection] = useState<Connection | null>(null)
  const [tokens, setTokens] = useState<TokenWithPrice[]>([])
  const [loading, setLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedToken, setSelectedToken] = useState<TokenWithPrice | null>(
    defaultToken ? (tokenList.find((token) => token.symbol === defaultToken) ?? null) : null
  )
  const utils = initUtils()

  const [sendAmount, setSendAmount] = useState<string>('0.05')
  const [priceLoaded, setPriceLoaded] = useState(false)

  useEffect(() => {
    const initializeDefaultAmount = async () => {
      try {
        if (selectedToken?.symbol === 'USDC') {
          setSendAmount('1.00') // Set to 1 USDC by default
          return
        }

        const prices = await fetchTokenPrices(['SOL'])
        const solPrice = prices['SOL'] // Fallback to 20 if price fetch fails
        setSendAmount((1 / solPrice).toFixed(4)) // Convert $1 to SOL amount
      } catch (error) {
        console.error('Error fetching SOL price:', error)
        setSendAmount((1 / 20).toFixed(4)) // Fallback to default $20 price
      } finally {
        setPriceLoaded(true)
      }
    }

    initializeDefaultAmount()
  }, [priceLoaded, selectedToken])

  const [isCreatingEscrow, setIsCreatingEscrow] = useState(false)
  const [escrowSecret, setEscrowSecret] = useState<string | null>(null)
  const [escrowTx, setEscrowTx] = useState<string | null>(null)
  const [escrowToken, setEscrowToken] = useState<TokenWithPrice | null>(null)
  const [showTempScreen, setShowTempScreen] = useState(false)
  const [isGeneratingLink, setIsGeneratingLink] = useState(false)
  const [generatedLink, setGeneratedLink] = useState<string | null>(null)

  const updateTokenBalances = useCallback(
    async (isRefreshAction = false) => {
      if (!walletSolana || !connection) return

      try {
        isRefreshAction ? setIsRefreshing(true) : setLoading(true)
        const balances = await fetchTokenBalances(connection, walletSolana.publicKey, tokenList)
        setTokens(balances)

        if (isRefreshAction) {
          toast.success('Token balances updated')
        }
      } catch (error) {
        console.error('Error fetching token balances:', error)
        toast.error('Failed to fetch token balances')
      } finally {
        setLoading(false)
        setIsRefreshing(false)
      }
    },
    [walletSolana, connection]
  )

  useEffect(() => {
    const conn = new Connection('https://api.devnet.solana.com', 'confirmed')
    setConnection(conn)
  }, [])

  useEffect(() => {
    if (connection) {
      updateTokenBalances()
    }
  }, [connection, updateTokenBalances])
  const formatBalance = (balance: number, token: TokenWithPrice) => {
    if (token.symbol === 'USDC') {
      return balance.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    }
    return balance.toLocaleString(undefined, {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4
    })
  }

  const formatUSD = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 4
    }).format(amount)
  }

  const getRedeemLink = () => {
    if (!escrowSecret || !escrowTx || !escrowToken) return ''
    if (process.env.NODE_ENV === 'development') {
      const link = `https://t.me/InstantSendTestBot/InstantSendLocalTest?startapp=${escrowSecret}_${walletSolana?.publicKey}_${escrowToken.symbol}`
      localStorage.setItem(escrowTx, link)
      return link
    } else {
      const link = `https://t.me/InstantSendAppBot/InstantSendApp?startapp=${escrowSecret}_${walletSolana?.publicKey}_${escrowToken.symbol}`
      localStorage.setItem(escrowTx, link)
      return link
    }
  }

  const handleSend = async () => {
    if (!selectedToken || !sendAmount || !connection || !walletSolana) {
      toast.error('Please fill in all fields and ensure wallet is connected')
      return
    }
    const balance = await connection.getBalance(new PublicKey(walletSolana.publicKey))
    if (balance < parseFloat(sendAmount) || balance === 0) {
      toast.error('Insufficient balance. Please, top up')
      return
    }

    if (isCreatingEscrow) return // Prevent multiple sends while processing

    setIsCreatingEscrow(true)
    setShowTempScreen(true)
    setIsGeneratingLink(true)
    setGeneratedLink(null)

    try {
      const secret = Math.random().toString(36).substring(2, 15)
      setEscrowSecret(secret)
      setEscrowToken(selectedToken)

      const expirationTime = Math.floor(Date.now() / 1000) + 24 * 60 * 60
      const tx = await initializeEscrow(
        connection,
        walletSolana,
        selectedToken.symbol === 'SOL' ? null : new PublicKey(selectedToken.mintAddress),
        parseFloat(sendAmount),
        new BN(expirationTime),
        secret,
        selectedToken.symbol === 'SOL'
      )

      setEscrowTx(tx)
      await updateTokenBalances()
      console.log('transaction', tx)
      const link = getRedeemLink()
      console.log('link', link)
      if (link && tx) {
        console.log('Storing in localStorage:', tx, link)
        localStorage.setItem(tx, link)
      }
      setGeneratedLink(link)
      setIsGeneratingLink(false)
    } catch (error) {
      console.error('Error:', error)
      if (error instanceof Error) {
        if (error.message.includes('0x1')) {
          toast.error('Insufficient balance. Please, top up')
        } else {
          toast.error('Insufficient balance. Please, top up')
          console.error('Transaction failed:', error)
        }
      } else {
        toast.error('An unknown error occurred. Please try again.')
      }
      setIsGeneratingLink(false)
      setIsCreatingEscrow(false)
      setShowTempScreen(false)
    }
  }

  return (
    <Card className="w-full max-w-4xl mx-auto">
      <CardContent className="p-4">
        {loading && !tokens.length ? (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            {tokens.length > 0 ? (
              <div className="space-y-3">
                {tokens
                  .filter((token) => ['SOL', 'USDC'].includes(token.symbol))
                  .map((token) => (
                    <motion.div
                      key={token.symbol}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSelectedToken(token)}
                    >
                      <div
                        className={cn(
                          'flex items-center p-4 rounded-lg border cursor-pointer transition-all',
                          'hover:border-primary',
                          selectedToken?.symbol === token.symbol && 'border-2 border-primary'
                        )}
                      >
                        <div className="flex items-center flex-1 gap-3">
                          <div className="w-8 h-8">{token.icon}</div>
                          <div className="flex flex-row space-x-4 justify-center items-center">
                            <div className="font-medium">{token.symbol}</div>
                            <span className="flex items-center bg-secondary rounded-3xl text-[9px] px-1">
                              Solana
                            </span>{' '}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-medium">
                            {formatBalance(token.balance || 0, token)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            ${((token.balance || 0) * (token.usdPrice || 0)).toFixed(2)}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">No tokens found</div>
            )}

            {selectedToken && (
              <div className="space-y-4 pt-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-semibold">Send {selectedToken.symbol}</h3>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="amount">Amount</Label>
                    <Input
                      id="amount"
                      type="number"
                      value={sendAmount}
                      onChange={(e) => setSendAmount(e.target.value)}
                      placeholder="Enter amount"
                      disabled={isCreatingEscrow}
                    />
                  </div>

                  <Button
                    className="w-full py-6 text-lg font-semibold bg-gradient-to-r shadow-lg hover:shadow-xl transition-all duration-300 border-2 "
                    onClick={handleSend}
                    disabled={isCreatingEscrow}
                  >
                    {isCreatingEscrow ? (
                      <Loader2 className="h-6 w-6 mr-3 animate-spin" />
                    ) : (
                      <Send className="h-6 w-6 mr-3" />
                    )}
                    Forward via Telegram
                  </Button>
                </div>
              </div>
            )}

            {showTempScreen && (
              <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
                <div className="bg-background p-6 rounded-lg max-w-sm w-full mx-4 space-y-6">
                  <h3 className="text-lg font-medium text-center">
                    {isGeneratingLink ? (
                      <>
                        <br />
                        Forward this link to your friend to transfer {sendAmount}{' '}
                        {selectedToken?.symbol}
                      </>
                    ) : (
                      <div className="space-y-4">
                        <br />
                        Forward this link to your friend to transfer {sendAmount}{' '}
                        {selectedToken?.symbol}
                        <br />
                        <div
                          className="p-3 bg-muted rounded-md break-all text-sm font-mono cursor-pointer"
                          onClick={() => {
                            const link = getRedeemLink()
                            navigator.clipboard.writeText(link)
                            toast.success('Copied')
                          }}
                        >
                          {getRedeemLink()}
                        </div>
                        <p className="text-sm text-muted-foreground text-center">
                          Link will expire in 24 hours
                        </p>
                        <Button
                          className="w-full py-6 text-lg font-semibold bg-gradient-to-r shadow-lg hover:shadow-xl transition-all duration-300 border-2 border-blue-400/20"
                          variant="default"
                          onClick={() => {
                            const link = getRedeemLink()
                            if (link) {
                              utils.shareURL(link)
                            }
                          }}
                        >
                          <Send className="h-6 w-6 mr-3" />
                          Forward via Telegram
                        </Button>
                      </div>
                    )}
                  </h3>

                  {isGeneratingLink ? (
                    <div className="flex justify-center">
                      <Loader2 className="h-8 w-8 animate-spin" />
                    </div>
                  ) : (
                    generatedLink && (
                      <div className="p-3 bg-muted rounded-md break-all text-sm font-mono">
                        {generatedLink}
                      </div>
                    )
                  )}

                  {isGeneratingLink ? null : (
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        setShowTempScreen(false)
                        setIsCreatingEscrow(false)
                        setEscrowSecret(null)
                        setEscrowTx(null)
                        setEscrowToken(null)
                        setGeneratedLink(null)
                      }}
                    >
                      Close
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
