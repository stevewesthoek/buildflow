import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ProChat Workbench',
  description: 'Work safely with your local projects through ChatGPT'
}

export default function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
