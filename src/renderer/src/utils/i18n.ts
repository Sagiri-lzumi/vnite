import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import resourcesToBackend from 'i18next-resources-to-backend'
import { ipcManager } from '~/app/ipc'

export async function i18nInit(): Promise<void> {
  const language = await ipcManager.invoke('system:get-language')
  console.warn('[i18n] Language:', language)

  const namespaces = [
    'config',
    'sidebar',
    'game',
    'adder',
    'importer',
    'updater',
    'utils',
    'record',
    'scanner',
    'cloudArchive',
    'transformer',
    'databaseInspector'
  ]

  const supportedLngs = ['zh-CN', 'zh-TW', 'ja', 'en', 'ru', 'fr', 'ko']

  await i18n
    .use(initReactI18next)
    .use(
      resourcesToBackend(async (language: string, namespace: string) => {
        return import(`@locales/${language}/${namespace}.json`).catch((error) => {
          console.error(`Unable to load translation file: ${language}/${namespace}`, error)
          return {}
        })
      })
    )
    .init({
      lng: language,
      fallbackLng: 'en',
      defaultNS: 'sidebar',
      fallbackNS: 'sidebar',
      returnEmptyString: false,
      ns: namespaces,
      interpolation: {
        escapeValue: false
      },
      partialBundledLanguages: true,
      supportedLngs
    })

  i18n.services.formatter?.add('gameTime', (value) => {
    const totalMinutes = Math.max(0, Math.round(Number(value || 0) / 1000 / 60))
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60

    if (hours > 0) {
      return minutes > 0 ? `${hours} h ${minutes} m` : `${hours} h`
    }

    return `${minutes} m`
  })

  i18n.services.formatter?.add('niceDate', (value, lng) => {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return ''

    return new Intl.DateTimeFormat(lng || undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(date)
  })

  i18n.services.formatter?.add('niceISO', (value) => {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return ''

    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  })

  i18n.services.formatter?.add('niceDateSeconds', (value, lng) => {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return ''

    return new Intl.DateTimeFormat(lng || undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: lng?.startsWith('en')
    }).format(date)
  })
}
