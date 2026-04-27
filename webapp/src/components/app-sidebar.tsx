import { Link, useLocation } from 'react-router'
import { useWalletUi } from '@wallet-ui/react'
import { NAV_ITEMS, type NavItem } from './nav-items'
import solanaLogo from '@/assets/solana-logo.svg'
import { CURRENT_PROGRAM_VERSION } from '@subscriptions/client'

export function AppSidebar() {
  const { pathname } = useLocation()
  const { cluster } = useWalletUi()
  const filteredItems = NAV_ITEMS.filter(
    (item) => !item.clusterFilter || item.clusterFilter.includes(cluster.id),
  )

  function isActive(path: string) {
    return path === '/' ? pathname === '/' : pathname === path
  }

  function isParentActive(item: NavItem) {
    if (isActive(item.path)) return true
    return item.children?.some((c) => isActive(c.path)) ?? false
  }

  return (
    <aside className="hidden md:flex flex-col w-64 shrink-0 bg-[#0a0a0a] text-sidebar-foreground border-r border-white/5">
      <div className="flex items-center gap-2 px-6 pt-8 pb-4">
        <span className="text-xl font-bold text-white tracking-tight">Subscriptions</span>
        <span className="text-sm font-bold text-blue-400/60">v{CURRENT_PROGRAM_VERSION}</span>
        <img src={solanaLogo} alt="Solana" className="h-5 w-5 shrink-0" />
      </div>
      <nav className="flex flex-col gap-2 px-4 pt-8">
        {filteredItems.map((item) => {
          const { label, path, icon: Icon, children } = item
          const active = isParentActive(item)
          return (
            <div key={path}>
              <Link
                to={path}
                className={`flex items-center gap-4 px-4 py-3.5 rounded-full text-[15px] font-medium transition-all duration-300 ${
                  active
                    ? 'bg-gradient-to-r from-purple-500/20 to-transparent border border-purple-500/30 text-white shadow-[0_0_20px_rgba(168,85,247,0.15)] backdrop-blur-md relative'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                }`}
              >
                {active && (
                  <div className="absolute inset-0 rounded-full shadow-[0_0_15px_rgba(168,85,247,0.3)] opacity-50 pointer-events-none" />
                )}
                <Icon className={`h-5 w-5 shrink-0 z-10 ${active ? 'text-white' : 'text-gray-500'}`} strokeWidth={active ? 2 : 1.5} />
                <span className="z-10">{label}</span>
              </Link>
              {active && children?.map((child) => {
                const childActive = isActive(child.path)
                const ChildIcon = child.icon
                return (
                  <Link
                    key={child.path}
                    to={child.path}
                    className={`flex items-center gap-3 ml-8 px-3 py-2 rounded-full text-[13px] font-medium transition-all duration-200 mt-1 ${
                      childActive
                        ? 'text-purple-300 bg-purple-500/10'
                        : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                    }`}
                  >
                    <ChildIcon className={`h-3.5 w-3.5 shrink-0 ${childActive ? 'text-purple-300' : 'text-gray-600'}`} strokeWidth={1.5} />
                    <span>{child.label}</span>
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
