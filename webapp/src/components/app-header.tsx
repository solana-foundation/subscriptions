import { useState } from 'react'
import { Button } from './ui/button'
import { Menu, X, Settings2 } from 'lucide-react'
import { WalletButton } from './solana/solana-provider'
import { TimeTravelButton } from './time-travel/time-travel-button'
import { Link, useLocation, useNavigate } from 'react-router'
import { useWalletUi } from '@wallet-ui/react'
import { NAV_ITEMS } from './nav-items'
import { CURRENT_PROGRAM_VERSION } from '@subscriptions/client'

function NetworkButton() {
  const navigate = useNavigate()
  const setupCluster = localStorage.getItem('setup-cluster') ?? ''
  const label = setupCluster === 'solana:devnet' ? 'Devnet' : setupCluster === 'solana:testnet' ? 'Testnet' : 'Localnet'

  return (
    <button
      onClick={() => {
        localStorage.removeItem('setup-complete-localnet')
        localStorage.removeItem('setup-complete-devnet')
        localStorage.removeItem('setup-cluster')
        navigate('/setup')
      }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-gray-300 hover:text-white"
    >
      <Settings2 className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

export function AppHeader() {
  const { pathname } = useLocation()
  const { cluster } = useWalletUi()
  const [showMenu, setShowMenu] = useState(false)
  const filteredItems = NAV_ITEMS.filter(
    (item) => !item.clusterFilter || item.clusterFilter.includes(cluster.id),
  )

  function isActive(path: string) {
    return path === '/' ? pathname === '/' : pathname.startsWith(path)
  }

  return (
    <header className="relative z-50 px-4 py-2 bg-neutral-100 dark:bg-neutral-900 dark:text-neutral-400">
      <div className="mx-auto flex justify-between items-center">
        <span className="text-xl md:hidden">Subscriptions <span className="text-sm font-bold text-blue-400/60">v{CURRENT_PROGRAM_VERSION}</span></span>

        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setShowMenu(!showMenu)}>
          {showMenu ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </Button>

        <div className="hidden md:flex items-center gap-4 ml-auto">
          <TimeTravelButton />
          <WalletButton />
          <NetworkButton />
        </div>

        {showMenu && (
          <div className="md:hidden fixed inset-x-0 top-[52px] bottom-0 bg-neutral-100/95 dark:bg-neutral-900/95 backdrop-blur-sm">
            <div className="flex flex-col p-4 gap-4 border-t dark:border-neutral-800">
              <ul className="flex flex-col gap-4">
                {filteredItems.map(({ label, path, icon: Icon, children }) => (
                  <li key={path}>
                    <Link
                      className={`flex items-center gap-3 hover:text-neutral-500 dark:hover:text-white text-lg py-2 ${isActive(path) ? 'text-neutral-500 dark:text-white' : ''}`}
                      to={path}
                      onClick={() => setShowMenu(false)}
                    >
                      <Icon className="h-5 w-5" />
                      {label}
                    </Link>
                    {children?.map((child) => (
                      <Link
                        key={child.path}
                        className={`flex items-center gap-3 ml-8 hover:text-neutral-500 dark:hover:text-white text-sm py-1.5 ${isActive(child.path) ? 'text-neutral-500 dark:text-white' : 'text-gray-500'}`}
                        to={child.path}
                        onClick={() => setShowMenu(false)}
                      >
                        <child.icon className="h-4 w-4" />
                        {child.label}
                      </Link>
                    ))}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-4">
                <TimeTravelButton />
                <WalletButton />
                <NetworkButton />
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  )
}
