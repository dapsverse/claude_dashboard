import { useRoute } from '../router.jsx';

const NAV = [
  { path: '/', label: 'Chat' },
  { path: '/agents', label: 'Agents' },
  { path: '/skills', label: 'Skills' },
  { path: '/activity', label: 'Activity' },
];

export function Layout({ rail, sidebar, children, modal, officeExpanded = false }) {
  const { path, navigate } = useRoute();

  return (
    // The chat column collapses to zero width when the office is expanded — the page still has its
    // nav, so this is a wider look at the rail rather than a mode you have to escape from.
    <div className={`shell${officeExpanded ? ' office-expanded' : ''}`}>
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
        {sidebar}
      </nav>
      <main>{children}</main>
      {rail}
      {/* A sibling of `main`, never a child of it, on purpose: `.shell.office-expanded main` drops
          its opacity to 0 so the collapsed chat column doesn't flash content while it shrinks, and a
          `position: fixed` descendant escapes that ancestor's `overflow: hidden` but NOT its opacity
          — a `fixed` element inside a parent with opacity < 1 is composited as part of that parent's
          layer, so the modal backdrop was rendering invisible while still eating every click meant
          for it. That is how a real repo owner ended up hitting Deny on a permission prompt they
          could not see. Keep this outside `main` even if `main` grows a transform/filter/opacity rule
          later — any of those traps a `position: fixed` child the same way. */}
      {modal}
    </div>
  );
}
