import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { ThemeProvider } from './theme';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
