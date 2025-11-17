
import React from 'react';

const Icon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5" {...props}>
    {props.children}
  </svg>
);

export const EditIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></Icon>;
export const SaveIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></Icon>;
export const SyncIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0011.664 0l3.181-3.183m-3.181-4.991v4.99" /></Icon>;
export const GenerateIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.898 20.562L16.25 22.5l-.648-1.938a2.25 2.25 0 01-1.473-1.473L12 18.75l1.938-.648a2.25 2.25 0 011.473-1.473L16.25 15l.648 1.938a2.25 2.25 0 011.473 1.473L20.25 18.75l-1.938.648a2.25 2.25 0 01-1.473 1.473z" /></Icon>;
export const UploadIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></Icon>;
export const BarcodeIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V17.25m12 0h-12M15.75 17.25v-3.375a1.125 1.125 0 011.125-1.125h.375V9.375c0-.621-.504-1.125-1.125-1.125h-9.75A1.125 1.125 0 003.75 9.375v1.5h.375c.621 0 1.125.504 1.125 1.125v3.375m0 0h12" /></Icon>;
export const CameraIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" /></Icon>;
export const SendIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></Icon>;
export const SparklesIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.898 20.562L16.25 22.5l-.648-1.938a2.25 2.25 0 01-1.473-1.473L12 18.75l1.938-.648a2.25 2.25 0 011.473-1.473L16.25 15l.648 1.938a2.25 2.25 0 011.473 1.473L20.25 18.75l-1.938.648a2.25 2.25 0 01-1.473 1.473z" /></Icon>;
export const DownloadIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></Icon>;
export const LinkIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></Icon>;
export const RefreshIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0011.664 0l3.181-3.183" /></Icon>;
export const ExportIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></Icon>;
export const SearchIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></Icon>;
export const LogoIcon = (props: React.SVGProps<SVGSVGElement>) => <Icon {...props} stroke="none" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5-10-5-10 5zM12 13.5l-10-5V12l10 5 10-5V8.5l-10 5z"/></Icon>;
export const TableIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125v-1.5c0-.621.504-1.125 1.125-1.125h17.25c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h.008v.008h-.008v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.375 4.5h17.25m-17.25 0a1.125 1.125 0 01-1.125 1.125v1.5c0 .621.504-1.125 1.125 1.125h17.25c.621 0 1.125.504 1.125 1.125v-1.5c0-.621-.504-1.125-1.125-1.125m-17.25 0h.008v.008h-.008V4.5zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
  </Icon>
);
export const PlusCircleIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
  </Icon>
);
export const SheetIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75c0-.231-.035-.454-.1-.664M6.75 7.5h1.5v.75h-1.5V7.5zm-1.5 0h.008v.008H5.25V7.5z" /></Icon>;
export const PrintIcon = () => <Icon><path strokeLinecap="round" strokeLinejoin="round" d="M6 9V4.5A1.5 1.5 0 017.5 3h9A1.5 1.5 0 0118 4.5V9m-12 0h12m-12 0a2.25 2.25 0 00-2.25 2.25V15h3v3.75c0 .414.336.75.75.75h7.5a.75.75 0 00.75-.75V15h3v-3.75A2.25 2.25 0 0018 9M9 15h6" /></Icon>;
export const WarehouseIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M3 10l9-7 9 7v10.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 20.5V10z"
    />
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 13h3v7H7zM14 13h3v7h-3z" />
  </Icon>
);
