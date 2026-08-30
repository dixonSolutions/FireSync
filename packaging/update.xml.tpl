<?xml version='1.0' encoding='UTF-8'?>
<!--
  Self-hosted update manifest. `npm run pack` generates a filled-in copy at
  build/update.xml; this template is here for reference.

  Serve it and the .crx over HTTPS from any static host. Chrome sends no
  cookies with update checks and ignores Set-Cookie in the response, so an
  unauthenticated static file is exactly right.
-->
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='EXTENSION_ID_HERE'>
    <updatecheck codebase='https://example.invalid/firesync/firesync-0.1.0.crx' version='0.1.0' />
  </app>
</gupdate>
