import { useRoute } from '../router.jsx';

const NAV = [
  { path: '/', label: 'Chat' },
  { path: '/agents', label: 'Agents' },
  { path: '/skills', label: 'Skills' },
  { path: '/activity', label: 'Activity' },
];

export function Layout({ rail, children }) {
  const { path, navigate } = useRoute();

  return (
    <div className="shell">
      <nav aria-label="Sections">
        <h1>agentpanel</h1>
        <ul>
          {NAV.map((item) => (
            <li key={item.path}>
              <a href={item.path}
                 aria-current={path === item.path ? 'page' : undefined}
                 onClick={(e) => { e.preventDefault(); navigate(item.path); }}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main>{children}</main>
      {rail}
    </div>
  );
}
