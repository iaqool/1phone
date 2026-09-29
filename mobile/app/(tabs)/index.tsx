import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { useMobileWallet } from '@wallet-ui/react-native-web3js'
import { checkWalletForSgt } from '../../../src/sgt'
import { buildConsumeInstruction, findHeldSgtToken, readEligibilityState } from '../../../src/eligibility'

type Status =
  | { kind: 'disconnected' | 'checking' | 'no-sgt' | 'error'; detail?: string }
  | { kind: 'unpublished'; mint: PublicKey }
  | { kind: 'ready' | 'registered' | 'used' | 'closed'; mint: PublicKey; deadline: bigint; receipt: PublicKey }
type WalletStatus = Status & { wallet?: string }

function campaignConfig() {
  const program = process.env.EXPO_PUBLIC_ONEPHONE_PROGRAM_ID
  const namespace = process.env.EXPO_PUBLIC_ONEPHONE_NAMESPACE
  if (!program || !namespace) return null
  try {
    return { programId: new PublicKey(program), namespace: new PublicKey(namespace) }
  } catch {
    throw new Error('Некорректные адреса кампании в настройках приложения')
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && /^(Кампания|Некорректн|Время сети|SGT больше)/.test(error.message)) return error.message
  return 'Не удалось получить данные Solana. Проверьте подключение и повторите.'
}

function shortAddress(address: string) {
  return `${address.slice(0, 5)}…${address.slice(-5)}`
}

function stateText(status: Status): { title: string; description: string; color: string } {
  switch (status.kind) {
    case 'disconnected':
      return { title: 'Подключите кошелёк', description: 'Проверим SGT в вашем кошельке.', color: '#94A3B8' }
    case 'checking':
      return { title: 'Проверяем SGT', description: 'Читаем данные Solana.', color: '#FBBF24' }
    case 'no-sgt':
      return { title: 'SGT не найден', description: 'Подключённый кошелёк сейчас не владеет Seeker Genesis Token.', color: '#FBBF24' }
    case 'unpublished':
      return { title: 'SGT найден', description: 'Кампания OnePhone ещё не опубликована в сети.', color: '#FBBF24' }
    case 'ready':
      return { title: 'Можно участвовать', description: 'Ваш SGT подходит. Регистрация запишет допуск в Solana.', color: '#7DD3FC' }
    case 'registered':
      return { title: 'Допуск записан', description: 'Этот SGT уже зарегистрирован на ваш кошелёк.', color: '#86EFAC' }
    case 'used':
      return { title: 'SGT уже использован', description: 'Для этого SGT допуск в кампании уже записан другим кошельком.', color: '#FBBF24' }
    case 'closed':
      return { title: 'Регистрация закрыта', description: 'Срок участия в этой кампании закончился.', color: '#94A3B8' }
    case 'error':
      return { title: 'Проверка не завершена', description: status.detail ?? 'Повторите попытку.', color: '#FCA5A5' }
  }
}

export default function OnePhoneScreen() {
  const { account, connect, disconnect, connection, signAndSendTransactions } = useMobileWallet()
  const [status, setStatus] = useState<WalletStatus>({ kind: 'disconnected' })
  const [busy, setBusy] = useState(false)
  const [signature, setSignature] = useState<{ wallet: string; value: string } | null>(null)
  const readId = useRef(0)
  const walletAddress = account?.address.toBase58()

  const load = useCallback(async (holder: PublicKey) => {
    const id = ++readId.current
    const wallet = holder.toBase58()
    setStatus({ kind: 'checking', wallet })
    try {
      const sgt = await checkWalletForSgt(connection, holder)
      if (id !== readId.current) return
      if (!sgt.hasSGT || !sgt.mintAddress) {
        setStatus({ kind: 'no-sgt', wallet })
        return
      }
      const mint = new PublicKey(sgt.mintAddress)
      const config = campaignConfig()
      if (!config) {
        setStatus({ kind: 'unpublished', mint, wallet })
        return
      }
      const eligibility = await readEligibilityState(connection, config.programId, config.namespace, mint, holder)
      if (id !== readId.current) return
      setStatus({ ...eligibility, mint, wallet })
    } catch (error) {
      if (id === readId.current) setStatus({ kind: 'error', detail: errorText(error), wallet })
    }
  }, [connection])

  useEffect(() => {
    if (walletAddress) {
      let active = true
      queueMicrotask(() => {
        if (active) void load(new PublicKey(walletAddress))
      })
      return () => {
        active = false
      }
    } else {
      ++readId.current
    }
  }, [walletAddress, load])

  async function handleConnect() {
    if (busy) return
    setBusy(true)
    try {
      await connect()
    } catch {
      setStatus({ kind: 'error', detail: 'Кошелёк не подключился. Повторите попытку в совместимом кошельке.' })
    } finally {
      setBusy(false)
    }
  }

  async function handleDisconnect() {
    if (busy) return
    setBusy(true)
    try {
      await disconnect()
    } catch {
      setStatus({ kind: 'error', detail: 'Не удалось отключить кошелёк. Повторите попытку.', wallet: walletAddress })
    } finally {
      setBusy(false)
    }
  }

  async function handleRegister() {
    if (busy || !account || visibleStatus.kind !== 'ready') return
    const id = readId.current
    const holder = account.address
    const mint = visibleStatus.mint
    setBusy(true)
    try {
      const config = campaignConfig()
      if (!config) throw new Error('Кампания ещё не опубликована')
      const current = await readEligibilityState(connection, config.programId, config.namespace, mint, holder)
      if (current.kind !== 'ready') throw new Error('Регистрация уже недоступна. Обновите статус.')
      const token = await findHeldSgtToken(connection, holder, mint)
      const instruction = buildConsumeInstruction(config.programId, config.namespace, holder, mint, token)
      const latest = await connection.getLatestBlockhashAndContext('confirmed')
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: holder,
        recentBlockhash: latest.value.blockhash,
        instructions: [instruction],
      }).compileToLegacyMessage())
      const sent = await signAndSendTransactions(transaction, latest.context.slot)
      const confirmation = await connection.confirmTransaction({ signature: sent, ...latest.value }, 'confirmed')
      if (confirmation.value.err) throw new Error('Транзакция отклонена сетью')
      if (id === readId.current) {
        setSignature({ wallet: holder.toBase58(), value: sent })
        await load(holder)
      }
    } catch (error) {
      if (id === readId.current) setStatus({ kind: 'error', detail: errorText(error), wallet: holder.toBase58() })
    } finally {
      setBusy(false)
    }
  }

  const connected = Boolean(walletAddress)
  const visibleStatus: Status = walletAddress
    ? status.wallet === walletAddress ? status : { kind: 'checking' }
    : status.kind === 'error' && !status.wallet ? status : { kind: 'disconnected' }
  const info = stateText(visibleStatus)
  const canRefresh = connected && !busy && visibleStatus.kind !== 'checking'
  const activeSignature = signature?.wallet === walletAddress ? signature?.value : null

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topline}>
          <Text style={styles.brand}>ONEPHONE</Text>
          <Text style={styles.network}>SOLANA MAINNET</Text>
        </View>

        <View style={styles.intro}>
          <Text style={styles.eyebrow}>SEEKER ACCESS</Text>
          <Text style={styles.title}>{'Один SGT.\nОдин допуск.'}</Text>
          <Text style={styles.lead}>Подключите кошелёк Seeker, проверьте токен и запишите участие в кампании.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>КОШЕЛЁК</Text>
          <Text style={styles.cardTitle}>{walletAddress ? shortAddress(walletAddress) : 'Не подключён'}</Text>
          {connected ? (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void handleDisconnect()} style={({ pressed }) => [styles.linkButton, pressed && styles.pressed, busy && styles.disabled]}>
              <Text style={styles.linkText}>Отключить кошелёк</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void handleConnect()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? 'Подключаем…' : 'Подключить кошелёк'}</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.card}>
          <View style={styles.statusTop}>
            <Text style={styles.label}>СТАТУС SGT</Text>
            {visibleStatus.kind === 'checking' ? <ActivityIndicator color="#FBBF24" /> : <View style={[styles.statusDot, { backgroundColor: info.color }]} />}
          </View>
          <Text style={styles.cardTitle}>{info.title}</Text>
          <Text style={styles.description}>{info.description}</Text>
          {'mint' in visibleStatus ? <Text selectable style={styles.data}>SGT: {shortAddress(visibleStatus.mint.toBase58())}</Text> : null}
          {'deadline' in visibleStatus ? (
            <Text style={styles.data}>Окно до {new Date(Number(visibleStatus.deadline) * 1000).toLocaleString('ru-RU')}</Text>
          ) : null}
          {visibleStatus.kind === 'ready' ? (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void handleRegister()} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, busy && styles.disabled]}>
              <Text style={styles.primaryText}>{busy ? 'Ожидаем кошелёк…' : 'Записать участие'}</Text>
            </Pressable>
          ) : null}
          {canRefresh ? (
            <Pressable accessibilityRole="button" onPress={() => void load(new PublicKey(walletAddress!))} style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
              <Text style={styles.linkText}>Обновить статус</Text>
            </Pressable>
          ) : null}
        </View>

        {activeSignature ? <Text selectable style={styles.signature}>Транзакция: {activeSignature}</Text> : null}

        <View style={styles.note}>
          <Text style={styles.noteTitle}>Что происходит после регистрации</Text>
          <Text style={styles.description}>OnePhone записывает допуск в Solana. При регистрации оплачиваются комиссия сети и аренда записи. Выплата через Torque организуется отдельно; запись допуска сама по себе не означает выплату.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0F172A' },
  content: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 44, gap: 16 },
  topline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: '#F8FAFC', fontSize: 16, fontWeight: '800', letterSpacing: 2 },
  network: { color: '#FBBF24', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  intro: { paddingTop: 32, paddingBottom: 16, gap: 14 },
  eyebrow: { color: '#FBBF24', fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  title: { color: '#F8FAFC', fontSize: 38, lineHeight: 44, fontWeight: '800' },
  lead: { color: '#CBD5E1', fontSize: 16, lineHeight: 24 },
  card: { backgroundColor: '#222735', borderColor: '#334155', borderWidth: 1, borderRadius: 20, padding: 20, gap: 12 },
  label: { color: '#94A3B8', fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  cardTitle: { color: '#F8FAFC', fontSize: 23, lineHeight: 28, fontWeight: '700' },
  description: { color: '#CBD5E1', fontSize: 15, lineHeight: 23 },
  statusTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  data: { color: '#94A3B8', fontSize: 13, lineHeight: 19 },
  primaryButton: { minHeight: 54, borderRadius: 13, backgroundColor: '#F59E0B', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginTop: 8 },
  primaryText: { color: '#0F172A', fontSize: 16, fontWeight: '800' },
  linkButton: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { color: '#FBBF24', fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
  signature: { color: '#86EFAC', fontSize: 13, lineHeight: 19 },
  note: { borderTopWidth: 1, borderColor: '#334155', paddingTop: 20, gap: 8 },
  noteTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
})
