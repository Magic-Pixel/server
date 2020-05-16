import {BigNumber} from "bignumber.js";
import btoa from "btoa";
import fetch, {Response} from "node-fetch";
import * as bitcore from "bitcore-lib-cash";
import * as slpjs from "slpjs";
import * as config from "./config";
import * as db from "./db";
import {GrpcClient} from "grpc-bchrpc-node";
import * as BITBOXSDK from 'bitbox-sdk';

// theres just the minimum needed here to do anything
declare module "bitcore-lib-cash" {
    export class HDPrivateKey {
      privateKey: any; // should be PrivateKey but slpjs broken typings
      publicKey: any; // should be PublicKey but slpjs broken typings
      xprivkey: string;


      constructor(arg?: string|Buffer|object);
      derive(arg: string|number, hardened?: boolean): HDPrivateKey;
      deriveChild(arg: string|number, hardened?: boolean): HDPrivateKey;

    }
}

const hdPrivateKey = new bitcore.HDPrivateKey(config.privateKey());

export function getAddress(serverId: number, userId: number): string {
  return slpjs.Utils.toSlpAddress(
    hdPrivateKey
      .deriveChild(serverId)
      .deriveChild(userId)
      .publicKey.toAddress().toString()
  );
}

// returns true if deposits added
export function performDepositResolution(
  serverId: number,
  userId: number
): Promise<boolean> {
  const address = getAddress(serverId, userId);

  return new Promise((resolve, reject) => {
    Promise.all([
      db.getLatestDeposits(serverId, userId),
      db.getAllTokens()
    ])
    .then(([pastDeposits, allTokens]) => {
      const pastDepositTxids = new Set(pastDeposits.map(d => d.txid));
      const acceptedTokens = new Map(allTokens.map(d => ([d.id, d])));

      const query: object = {
        "v": 3,
        "q": {
          "find": {
            "slp.detail.outputs.address": address,
            "slp.valid": true,
            "tx.h": {
              "$nin": [...pastDepositTxids].slice(0, 40)
            }
          },
          "sort": {
            "blk.i": -1
          },
          "limit": 10
        }
      };

      const b64: string = btoa(JSON.stringify(query));
      const url: string = 'https://slpdb.fountainhead.cash/q/' + b64;
      fetch(url)
      .then((res) => res.json())
      .then((data) => {
        console.log(data);
        const newDeposits: any[] = data.c.concat(data.u);
        const deposits = [];

        for (const m of newDeposits) {
          const txid = m.tx.h;

          if (pastDepositTxids.has(txid)) {
            continue;
          }

          const tokenId = m.slp.detail.tokenIdHex;
          if (! acceptedTokens.has(tokenId)) {
            continue;
          }

          let oamnt = new BigNumber(0);

          for (const o of m.slp.detail.outputs) {
            if (o.address === address) {
              oamnt = oamnt.plus(new BigNumber(o.amount));
            }
          }

          deposits.push(db.depositSlp(
            serverId,
            userId,
            txid,
            acceptedTokens.get(tokenId)!,
            oamnt
          ));
        }

        Promise.all(deposits)
        .then((depositResults) => {
          console.log('depositResults', depositResults);
          if (depositResults.length > 0) {
            return resolve(true);
          } else {
            return resolve(false);
          }
        });
      });
    });
  });
}


const client = new GrpcClient();
const logger = console;
const getRawTransactions = async (txids: string[]) => {
  const getRawTransaction = async (txid: string) => {
    console.log('get_raw_transaction', txid);
    return await client.getRawTransaction({hash: txid, reversedHashOrder: true});
  };

  return (await Promise.all(
    txids.map((txid: string) => getRawTransaction(txid))))
    .map((res: any) => Buffer.from(res.getTransaction_asU8()).toString("hex"));
};
const validator = new slpjs.TrustedValidator({getRawTransactions, logger});
const BITBOX = new BITBOXSDK.BITBOX();
const network = new slpjs.BchdNetwork({BITBOX, client, validator, logger});


export function withdraw(
  serverId: number,
  userId: number,
  tokenId: string,
  address: string,
  amount: BigNumber
): Promise<boolean> {
  return new Promise(async (resolve, reject) => {
    const token = await db.getTokenById(tokenId);
    if (token === null) {
      return resolve(false);
    }

    const fundingAddress           = config.fundingAddress();     // <-- must be simpleledger format
    const fundingWif               = config.fundingWif();        // <-- compressed WIF format
    const tokenReceiverAddress     = [ address ]; // <-- must be simpleledger format
    const bchChangeReceiverAddress = config.fundingAddress();     // <-- must be simpleledger format
    const tokenDecimals: number    = token.decimals;
    const sendAmounts: BigNumber[] = [ amount.times(10**tokenDecimals) ];

    const balances = await network.getAllSlpBalancesAndUtxos(fundingAddress) as slpjs.SlpBalancesResult;
    if(balances.slpTokenBalances[tokenId] === undefined) {
      console.error('error', 'out_of_funds');
      return; // TODO error
    }

    const inputUtxos = balances.slpTokenUtxos[tokenId].concat(balances.nonSlpUtxos);
    inputUtxos.forEach(txo => txo.wif = fundingWif);

    const requiredNonTokenOutputs = [{
      satoshis: 1000,
      receiverAddress: slpjs.Utils.toCashAddress(tokenReceiverAddress[0])
    }];

    console.log('withdraw', {
      tokenId,
      sendAmounts,
      inputUtxos,
      tokenReceiverAddress,
      bchChangeReceiverAddress,
      requiredNonTokenOutputs
    });

    let txid = null;
    try {
      txid = await network.simpleTokenSend(
        tokenId,
        sendAmounts,
        inputUtxos,
        tokenReceiverAddress,
        bchChangeReceiverAddress,
        requiredNonTokenOutputs
      );
    } catch (e) {
      console.log('send_error', e);
      // process.exit(1);
    }

    // db.withdraw();


    return resolve(true);
  });
}
