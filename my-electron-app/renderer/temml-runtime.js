// Bridge Temml's ESM export to the existing browser-global contract.
import temml from 'temml';

window.temml = window.temml || temml;
