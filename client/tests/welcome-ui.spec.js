'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('welcome verifies a self-signed invitation before registration and keeps SSH secrets in main', async () => {
  test.setTimeout(90000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-welcome-'));
  let app, server;
  const received = [];
  try {
    const key = path.join(root,'key.pem'), certPath = path.join(root,'cert.pem');
    expect(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-sha256','-nodes','-keyout',key,'-out',certPath,'-days','1','-subj','/CN=localhost'],{encoding:'utf8'}).status).toBe(0);
    const cert = fs.readFileSync(certPath);
    const pin = new crypto.X509Certificate(cert).fingerprint256;
    const hostKey = require('ssh2').utils.generateKeyPairSync('ed25519').public.split(' ').slice(0,2).join(' ');
    const user = { id:'welcome-user',uid:'u-welcome',username:'welcome',role:'member' };
    const rootUser = { id:'root',uid:'u-root',username:'root',role:'root' };
    server = https.createServer({key:fs.readFileSync(key),cert},(req,res) => {
      let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
        const value=JSON.parse(body);received.push(value);
        const syncCredential={mode:'restricted',host:'127.0.0.1',port:3103,user:'bobocloud',password:'only-main-sees-this',hostKey};
        let response={success:true};
        if(value.action==='inspectEnrollment')response.data={kind:value.enrollmentToken==='r'.repeat(43)?'root':'register',requiresPasswordSetup:value.enrollmentToken==='r'.repeat(43),expiresAt:new Date(Date.now()+600000).toISOString(),version:'3.0.1'};
        if(value.action==='register')response={success:true,token:'bobsess_welcome',expiresAt:new Date(Date.now()+3600000).toISOString(),user,data:{syncCredential}};
        if(value.action==='login')response={success:true,token:'bobsess_root',expiresAt:new Date(Date.now()+3600000).toISOString(),user:rootUser,data:{syncCredential}};
        if(value.action==='whoami')response={success:true,user:req.headers.authorization==='Bearer bobsess_root'?rootUser:user};
        if(value.action==='getSyncCredential')response.data={syncCredential};
        if(value.action==='serverInfo')response={success:true,authMode:'multi',version:'3.0.1'};
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));
      });
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    app=await electron.launch({args:['.','--user-data-dir='+path.join(root,'chromium')],env:{...process.env,APPDATA:path.join(root,'appdata'),HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),BOBO_FORCE_FIRST_RUN:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'}});
    const page=await app.firstWindow();await page.waitForFunction(()=>document.documentElement.dataset.boboReady==='true');
    await expect(page.locator('#welcome-page')).toBeVisible();
    await expect(page.locator('#empty-state')).toBeHidden();
    await expect(page.locator('#settings-modal')).toBeHidden();
    await page.selectOption('#welcome-language','zh-CN');
    await expect(page.locator('#welcome-title')).toHaveText('下一次灵感，就从这里开始。');
    await page.selectOption('#welcome-language','ja');
    await expect(page.locator('#welcome-title')).toHaveText('次のアイデアを、ここから。');
    await page.selectOption('#welcome-language','en');
    await expect(page.locator('#welcome-title')).toHaveText('Make room for your next idea.');
    const descriptor={v:1,host:'127.0.0.1',httpPort:server.address().port,wsPort:3101,dapChildWsPort:3102,certificateFingerprints:[pin],token:'a'.repeat(43),kind:'register'};
    const link = value=>'bobocloud://enroll#'+Buffer.from(JSON.stringify(value)).toString('base64url');
    await page.fill('#welcome-link',link({...descriptor,certificateFingerprints:['00'.repeat(32)]}));await page.click('#welcome-preview');
    await expect(page.locator('#welcome-preview')).toBeEnabled();
    await expect(page.locator('#welcome-overview')).toBeHidden();
    expect(received).toEqual([]);
    await page.fill('#welcome-link',link(descriptor));await page.click('#welcome-preview');
    await expect(page.locator('#welcome-overview')).toBeVisible();
    expect(received.map(x=>x.action)).toEqual(['inspectEnrollment']);
    await page.screenshot({path:path.join(process.cwd(),'test-results','welcome-verified.png')});
    await page.click('#welcome-connect');await expect(page.locator('#auth-overlay')).toBeVisible();
    await expect(page.locator('#auth-form-register')).toBeVisible();
    await page.fill('#auth-reg-username','welcome');await page.fill('#auth-reg-email','welcome@example.com');await page.fill('#auth-reg-password','Welcome-password!');await page.fill('#auth-reg-password2','Welcome-password!');
    await page.click('#auth-submit');await expect(page.locator('#auth-overlay')).toBeHidden();
    const settings=await page.evaluate(()=>window.api.readServerSettings());
    expect(settings.pass).toBe('');expect(settings.passConfigured).toBe(true);expect(settings.sshPort).toBe(3103);
    expect(await page.locator('body').innerText()).not.toContain('only-main-sees-this');
    expect(received.filter(x=>x.action==='register')).toHaveLength(1);

    await page.evaluate(() => window.BOBO.welcome.open());
    const rootDescriptor={...descriptor,token:'r'.repeat(43),kind:'root'};
    await page.fill('#welcome-link',link(rootDescriptor));await page.click('#welcome-preview');
    await expect(page.locator('#welcome-kind')).toHaveText('First administrator setup');
    await page.click('#welcome-connect');
    await expect(page.locator('#auth-form-root-setup')).toBeVisible();
    await page.fill('#auth-root-password','New-root-password!');
    await page.fill('#auth-root-password2','New-root-password!');
    await page.click('#auth-submit');await expect(page.locator('#auth-overlay')).toBeHidden();
    const claim=received.find(x=>x.action==='login');
    expect(claim.password).toBe('New-root-password!');
    expect(claim.identity).toBeUndefined();
    expect(claim.enrollmentToken).toBe('r'.repeat(43));
    expect(claim.deviceName).toBe('BOBOCLOUD desktop');
    expect(claim.devicePlatform).toBe(process.platform==='win32'?'Windows':process.platform==='darwin'?'macOS':process.platform==='linux'?'Linux':'Desktop');
  } finally {
    if(app) {try {await app.close();}catch{try {await app.evaluate(({app})=>app.exit(0));}catch{}}}
    if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await fs.promises.rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
