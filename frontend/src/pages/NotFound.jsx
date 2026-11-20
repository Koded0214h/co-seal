import { Link } from 'react-router-dom';
import { Page } from '../components/Layout.jsx';
import { SealMark } from '../components/Logo.jsx';

export default function NotFound() {
  return (
    <Page max="max-w-lg">
      <div className="text-center py-20">
        <SealMark size={56} className="mx-auto" />
        <h1 className="mt-5 text-2xl font-bold text-ink">This link is empty</h1>
        <p className="mt-2 text-muted">The transaction doesn't exist, or its link expired. Every real CoSeal link opens an isolated 2-of-3 escrow for one transaction.</p>
        <Link to="/" className="btn-gold mt-6 inline-flex">Create a transaction</Link>
      </div>
    </Page>
  );
}
