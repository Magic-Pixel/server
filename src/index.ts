import express from "express";
import path from "path";
import {BigNumber} from "bignumber.js";
import * as mojang from "./mojang";
import * as db from "./db";
import * as config from "./config";
import * as slp from "./slp";

const app = express();

app.enable('trust proxy');
app.use(express.json())

app.post('/api/minecraft/authenticate', async (req: any, res) => {
  const email = req.body.email;
  const password = req.body.password;
  const serverId = req.body.serverId;

  const authResponse = await mojang.authenticate(email, password);
  if (authResponse === null) {
    return res.json({
      success: false,
      msg: "couldn't authenticate with mojang"
    });
  }

  const userId = await db.getUserId(serverId, authResponse.profileId);
  if (userId === null) {
    return res.json({
      success: false,
      msg: "not on this server"
    });
  }

  const balances = await db.getAllTokenBalances(userId);

  const balObj: any = {};
  for (const prop of balances) {
    balObj[prop[0]] = prop[1].toString();
  }

  return res.json({
    success: true,
    auth: authResponse,
    balances: balObj
  });
});

app.post('/api/minecraft/withdraw', async (req: any, res) => {
  const email = req.body.email;
  const password = req.body.password;
  const address = req.body.address;
  const serverId = parseInt(req.body.serverId, 10);
  const amount = new BigNumber(req.body.amount);
  const tokenId = req.body.tokenId;

  const authResponse = await mojang.authenticate(email, password)
  if (authResponse === null) {
    return res.json({
      success: false,
      msg: "couldn't authenticate with mojang"
    });
  }

  const userId = await db.getUserId(serverId, authResponse.profileId)
  if (userId === null) {
    return res.json({
      success: false,
      msg: "not on this server"
    });
  }

  const token = await db.getTokenById(tokenId);
  if (token === null) {
    return res.json({
      success: false,
      msg: "token not found"
    });
  }

  const txid = await db.withdrawSlp(serverId, userId, token, address, amount);

  return res.json({
    success: txid !== null,
    txid,
  });
});


const helpText = (): string => `Magic Pixel | magicpixel.xyz
/mpx balance [token?]
/mpx send [username] [amount] [token?]
/mpx deposit`;

function getBalances(serverId: number, uuid: string): Promise<Map<string, BigNumber>> {
  return new Promise(async (resolve, reject) => {
    const userId = await db.getOrCreateUserId(serverId, uuid);
    const balances = await db.getAllTokenBalances(userId);
    return resolve(balances);
  });
}

app.post('/api/command/minecraft', async (req: any, res) => {
  const serverData = await db.authenticateServer(req.header('X-Auth-Token'), req.ip);
  if (serverData === null) {
    return res.json({
      msg: 'Could not authenticate'
    });
  }

  if (typeof req.query.q === 'undefined') {
    return res.json({
      msg: 'Query parameter "q" does not exist'
    });
  }

  const q: string = req.query.q.trim();
  const cmd: string[] = q.split(' ');
  const uuid: string = req.query.uuid.replace(/-/g, '');

  if (cmd.length === 0) {
    return res.json({
      msg: helpText()
    });
  }

  if (cmd[0] === 'help') {
    return res.json({
      msg: helpText()
    });
  }
  else if (cmd[0] === 'version') {
    return res.json({
      msg: 'Magic Pixel 0.0.1 | magicpixel.xyz'
    });
  }
  else if ((cmd[0] === 'b' || cmd[0] === 'balance') &&
           (cmd.length === 1 || cmd.length === 2)
  ) {
    const balances = await getBalances(serverData.id, uuid);
    let msg = "";

    if (cmd.length === 1) {
      for (const [k, v] of balances) {
        msg += `${v} ${k}\n`;
      }
    } else if (cmd.length === 2) {
      for (const [k, v] of balances) {
        if (k === cmd[1]) {
          msg += `${v} ${k}\n`;
        }
      }
    }

    if (msg === '') {
      msg = `You don't have any tokens\nTry "/mpx deposit"`;
    }

    return res.json({
      msg
    });
  }
  else if ((cmd[0] === 's' || cmd[0] === 'send') &&
           (cmd.length === 3 || cmd.length === 4)
  ) {
    const sendUuid:  string    = uuid.replace(/-/g, '');
    const username:  string    = cmd[1].toLowerCase();
    const amount:    BigNumber = new BigNumber(cmd[2]);
    const tokenName: string    = ((cmd.length === 4) ? cmd[3] : "MPX").toLowerCase();

    const [sendUsername, recvUuid] = await Promise.all([
      // ensure sending uuid exists
      mojang.lookupMinecraftUsername(sendUuid),
      // ensure receiving username exists
      mojang.lookupMinecraftUuid(username)
    ]);
    if (sendUsername === null) {
      return res.json({
        msg: `"${username}" not found, check spelling`
      });
    }

    if (recvUuid === null) {
      return res.json({
        msg: 'Receiver not found\n/mpx send [username] [amount] [token]'
      });
    }

    const [sendUserId, recvUserId, token] = await Promise.all([
      db.getOrCreateUserId(serverData.id, sendUuid),
      db.getOrCreateUserId(serverData.id, recvUuid),
      db.getTokenByName(tokenName)
    ]);
    if (sendUserId === null) {
      return res.json({
        msg: 'Send uuid not found'
      });
    }

    if (token === null) {
      return res.json({
        msg: `Token "${tokenName}" not found`
      });
    }

    if (sendUserId === recvUserId) {
      return res.json({
        msg: 'Cannot send to yourself'
      });
    }

    if (amount.isLessThan(1)) {
      return res.json({
        msg: `Cannot send less than 1 ${tokenName}`
      });
    }

    const transferResult = await db.transfer(serverData.id, sendUserId, recvUserId, token, amount)
    if (transferResult.success) {
      return res.json({
        msg: `Sent ${amount} ${tokenName} to ${username}`,
        msgs: [
          {
            uuid: recvUuid,
            msg: `${sendUsername} sent you ${amount} ${tokenName}`
          }
        ]
      });
    } else {
      return res.json({
        msg: transferResult.errorMsg
      });
    }
  }
  else if ((cmd[0] === 'd' || cmd[0] === 'deposit') &&
           (cmd.length === 1)
  ) {
    const userId = await db.getOrCreateUserId(serverData.id, uuid);
    const deposited = await slp.performDepositResolution(serverData.id, userId);
    if (deposited) {
      const balances = await db.getAllTokenBalances(userId);
      let msg = "Deposit received\n";

      for (const [k, v] of balances) {
        msg += `${v} ${k}\n`;
      }

      return res.json({
        msg
      });
    } else {
      return res.json({
        msg: 'No deposits found\nGo to magicpixel.xyz/deposit'
      });
    }
  }
  else {
    return res.json({
      msg: helpText()
    });
  }
});

app.get('/api/balance/:uuid', async (req: any, res) => {
  const serverData = await db.authenticateServer(req.header('X-Auth-Token'), req.ip);
  if (serverData === null) {
    return res.json({
      success: false,
      msg: 'could not authenticate',
    });
  }

  const balances = await getBalances(serverData.id, req.params.uuid);
  const ret: any = {};
  for (const [k, v] of balances) {
    ret[k] = v;
  }

  return res.json({
    success: true,
    msg: ret
  });
});

app.post('/api/send/:uuid1/:uuid2/:token_id/:amount', async (req: any, res) => {
  const sendUuid: string = req.params.uuid1.replace(/-/g, '');
  const recvUuid: string = req.params.uuid2.replace(/-/g, '');
  const tokenId: string = req.params.token_id;
  const amount: BigNumber = new BigNumber(req.params.amount);

  const serverData = await db.authenticateServer(req.header('X-Auth-Token'), req.ip);
  if (serverData === null) {
    return res.json({
      success: false,
      msg: 'could not authenticate',
    });
  }

  const [sendUsername, recvUsername] = await Promise.all([
    // ensure sending uuid exists
    mojang.lookupMinecraftUsername(sendUuid),
    // ensure receiving username exists
    mojang.lookupMinecraftUsername(recvUuid)
  ]);
  if (sendUsername === null) {
    return res.json({
      success: false,
      msg: 'could not find uuid1'
    });
  }

  if (recvUsername === null) {
    return res.json({
      success: false,
      msg: 'could not find uuid2'
    });
  }

  const [sendUserId, recvUserId, token] = await Promise.all([
    db.getOrCreateUserId(serverData.id, sendUuid),
    db.getOrCreateUserId(serverData.id, recvUuid),
    db.getTokenById(tokenId)
  ]);
  if (token === null) {
    return res.json({
      success: false,
      error: 'token not found',
    });
  }

  if (sendUserId === recvUserId) {
    return res.json({
      success: false,
      msg: 'cannot send to yourself'
    });
  }

  const result = await db.transfer(serverData.id, sendUserId, recvUserId, token, amount);
  if (result.success) {
    return res.json({
      success: true,
      msg: 'Successfully sent',
    });
  } else {
    return res.json({
      success: false,
      msg: result.errorMsg,
    });
  }
});

app.get('/api/tokens', async (req: any, res) => {
  const tokens = await db.getAllTokens();
  return res.json(tokens);
});

app.get('/api/servers', async (req: any, res) => {
  const servers = await db.getAllServers();
  return res.json(servers.map(t => ({
    id:         t.id,
    game:       t.game,
    ip_address: t.ip_address
  })));
});

app.get('/api/minecraft/lookup_uuid/:username', async (req: any, res) => {
  const uuid = await mojang.lookupMinecraftUuid(req.params.username);
  return res.json({
    uuid
  });
});

app.get('/api/deposit/minecraft/:uuid', async (req: any, res) => {
  const uuid = req.params.uuid;

  const username = mojang.lookupMinecraftUsername(uuid);
  if (username === null) {
    return res.json({
      error: 'uuid not found'
    });
  }

  const servers = await db.getAllServers();
  const addressPairs = await Promise.all(servers.map((s) => {
    return db.getOrCreateUserId(s.id, uuid)
    .then((userId) => ({
      server: s,
      address: slp.getAddress(s.id, userId)
    }));
  }));

  return res.json(addressPairs);
});

app.post('/api/server/transfers', async (req: any, res) => {
  const serverData = await db.authenticateServer(req.header('X-Auth-Token'), req.ip);
  if (serverData === null) {
    return res.json({
      success: false,
      msg: 'could not authenticate',
    });
  }

  const transfers = await db.getAllServerTransfers(serverData.id);
  return res.json(transfers);
});

app.listen(config.port(), () => {
  console.log(`server started at http://localhost:${config.port()}`);
});
