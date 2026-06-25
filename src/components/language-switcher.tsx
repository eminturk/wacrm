'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Globe } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const LOCALES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
] as const

type LocaleCode = (typeof LOCALES)[number]['code']

function getStoredLocale(): LocaleCode {
  if (typeof document === 'undefined') return 'en'
  const match = document.cookie.match(/wacrm_locale=([^;]+)/)
  const value = match?.[1] ?? 'en'
  return (LOCALES.some((l) => l.code === value) ? value : 'en') as LocaleCode
}

export function LanguageSwitcher() {
  const [current, setCurrent] = useState<LocaleCode>(getStoredLocale)
  const [, startTransition] = useTransition()
  const router = useRouter()

  const switchLocale = async (locale: LocaleCode) => {
    await fetch('/api/locale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale }),
    })
    setCurrent(locale)
    startTransition(() => {
      router.refresh()
    })
  }

  const currentLocale = LOCALES.find((l) => l.code === current) ?? LOCALES[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label="Change language"
      >
        <Globe className="h-4 w-4" />
        <span className="hidden sm:inline">{currentLocale.flag} {currentLocale.label}</span>
        <span className="sm:hidden">{currentLocale.flag}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LOCALES.map((locale) => (
          <DropdownMenuItem
            key={locale.code}
            onClick={() => switchLocale(locale.code)}
            className={current === locale.code ? 'font-medium text-primary' : ''}
          >
            <span className="mr-2">{locale.flag}</span>
            {locale.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
