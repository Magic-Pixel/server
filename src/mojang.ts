import fetch, {Response} from "node-fetch";
import NodeCache from "node-cache";
import * as db from "./db";
const ygg = require('yggdrasil')();// tslint:disable-line

const uuidCache     = new NodeCache(); // username -> uuid
const usernameCache = new NodeCache(); // uuid -> username
const authCache     = new NodeCache(); // access-token - > uuid

interface MojangUuidLookupResponse {
    name: string;
    id:   string;
};

interface MojangNameLookupResponse {
    name: string;
};

export function lookupMinecraftUsername(uuid: string): Promise<string|null> {
  uuid = uuid.replace(/-/g, '');

  return new Promise((resolve, reject) => {
    const clookup: string|undefined = usernameCache.get(uuid);

    if (clookup !== undefined) {
      return resolve(clookup);
    }

    fetch('https://api.mojang.com/user/profiles/'+uuid+'/names')
    .then((resp: Response) => resp.json())
    .then((json: MojangNameLookupResponse[]) => {
      if (json.length === 0) {
        resolve(null);
      }

      const latestUsername: string = json[0].name;

      usernameCache.set(uuid, latestUsername);
      resolve(latestUsername);
    })
    .catch((e) => {
      console.error(e);
      resolve(null);
    });
  });
}

export function lookupMinecraftUuid(username: string): Promise<string|null> {
  return new Promise((resolve, reject) => {
    const clookup: string|undefined = uuidCache.get(username);

    if (clookup) {
      return resolve(clookup);
    }

    fetch('https://api.mojang.com/users/profiles/minecraft/'+username)
    .then((resp: Response) => resp.json())
    .then((json: MojangUuidLookupResponse) => {
      const uuid: string = json.id;

      uuidCache.set(username, uuid);
      return resolve(uuid);
    })
    .catch((e) => {
      console.error(e);
      resolve(null);
    });
  });
}

interface AuthenticationResponse {
  accessToken: string;
  clientToken: string;
  profileId: string;
  profileName: string;
}

export function authenticate(username: string, password: string): Promise<AuthenticationResponse|null> {
  return new Promise((resolve, reject) => {
    ygg.auth({
      user: username,
      pass: password
    }, (err: any, data: any) => {
      if (err !== null) {
        return resolve(null);
      }

      const accessToken = data.accessToken;
      const clientToken = data.clientToken;
      const profileId = data.selectedProfile.id;
      const profileName = data.selectedProfile.name;

      authCache.set(accessToken, profileId);

      return resolve({
        accessToken,
        clientToken,
        profileId,
        profileName
      });
    });
  });
}
