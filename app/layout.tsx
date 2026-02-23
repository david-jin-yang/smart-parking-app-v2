import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ParkFlow',
  description: 'Smart Parking Intelligence',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="bg-mesh" aria-hidden="true" />
        {children}
      </body>
    </html>
  )
}
