/*
Copyright 2020 - 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { TestClient } from '../../TestClient';
import { MatrixCall, CallErrorCode, CallEvent, supportsMatrixCall, CallType } from '../../../src/webrtc/call';
import { SDPStreamMetadataKey, SDPStreamMetadataPurpose } from '../../../src/webrtc/callEventTypes';
import { RoomMember } from "../../../src";
import {
    DUMMY_SDP,
    MockMediaHandler,
    MockMediaStream,
    MockMediaStreamTrack,
    MockMediaDeviceInfo,
    MockRTCPeerConnection,
} from "../../test-utils/webrtc";
import { CallFeed } from "../../../src/webrtc/callFeed";

describe('Call', function() {
    let client;
    let call;
    let prevNavigator;
    let prevDocument;
    let prevWindow;

    beforeEach(function() {
        prevNavigator = global.navigator;
        prevDocument = global.document;
        prevWindow = global.window;

        global.navigator = {
            mediaDevices: {
                // @ts-ignore Mock
                getUserMedia: () => new MockMediaStream("local_stream"),
                // @ts-ignore Mock
                enumerateDevices: async () => [new MockMediaDeviceInfo("audio"), new MockMediaDeviceInfo("video")],
            },
        };

        global.window = {
            // @ts-ignore Mock
            RTCPeerConnection: MockRTCPeerConnection,
            // @ts-ignore Mock
            RTCSessionDescription: {},
            // @ts-ignore Mock
            RTCIceCandidate: {},
            getUserMedia: () => new MockMediaStream("local_stream"),
        };
        // @ts-ignore Mock
        global.document = {};

        client = new TestClient("@alice:foo", "somedevice", "token", undefined, {});
        // We just stub out sendEvent: we're not interested in testing the client's
        // event sending code here
        client.client.sendEvent = () => {};
        client.client.mediaHandler = new MockMediaHandler;
        client.client.getMediaHandler = () => client.client.mediaHandler;
        client.httpBackend.when("GET", "/voip/turnServer").respond(200, {});
        call = new MatrixCall({
            client: client.client,
            roomId: '!foo:bar',
        });
        // call checks one of these is wired up
        call.on('error', () => {});
    });

    afterEach(function() {
        client.stop();
        global.navigator = prevNavigator;
        global.window = prevWindow;
        global.document = prevDocument;
    });

    it('should ignore candidate events from non-matching party ID', async function() {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;
        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
        });

        call.peerConn.addIceCandidate = jest.fn();
        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    candidates: [
                        {
                            candidate: '',
                            sdpMid: '',
                        },
                    ],
                };
            },
        });
        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(1);

        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'some_other_party_id',
                    candidates: [
                        {
                            candidate: '',
                            sdpMid: '',
                        },
                    ],
                };
            },
        });
        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(1);

        // Hangup to stop timers
        call.hangup(CallErrorCode.UserHangup, true);
    });

    it('should add candidates received before answer if party ID is correct', async function() {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;
        call.peerConn.addIceCandidate = jest.fn();

        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    candidates: [
                        {
                            candidate: 'the_correct_candidate',
                            sdpMid: '',
                        },
                    ],
                };
            },
        });

        call.onRemoteIceCandidatesReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'some_other_party_id',
                    candidates: [
                        {
                            candidate: 'the_wrong_candidate',
                            sdpMid: '',
                        },
                    ],
                };
            },
        });

        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(0);

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'the_correct_party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
        });

        expect(call.peerConn.addIceCandidate.mock.calls.length).toBe(1);
        expect(call.peerConn.addIceCandidate).toHaveBeenCalledWith({
            candidate: 'the_correct_candidate',
            sdpMid: '',
        });
    });

    it('should map asserted identity messages to remoteAssertedIdentity', async function() {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;
        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
        });

        const identChangedCallback = jest.fn();
        call.on(CallEvent.AssertedIdentityChanged, identChangedCallback);

        await call.onAssertedIdentityReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    asserted_identity: {
                        id: "@steve:example.com",
                        display_name: "Steve Gibbons",
                    },
                };
            },
        });

        expect(identChangedCallback).toHaveBeenCalled();

        const ident = call.getRemoteAssertedIdentity();
        expect(ident.id).toEqual("@steve:example.com");
        expect(ident.displayName).toEqual("Steve Gibbons");

        // Hangup to stop timers
        call.hangup(CallErrorCode.UserHangup, true);
    });

    it("should map SDPStreamMetadata to feeds", async () => {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;

        call.getOpponentMember = () => {
            return { userId: "@bob:bar.uk" };
        };

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                    [SDPStreamMetadataKey]: {
                        "remote_stream": {
                            purpose: SDPStreamMetadataPurpose.Usermedia,
                            id: "feed_id",
                            audio_muted: true,
                            video_muted: false,
                        },
                    },
                };
            },
        });

        call.pushRemoteFeed(
            new MockMediaStream(
                "remote_stream",
                [
                    new MockMediaStreamTrack("remote_audio_track", "audio"),
                    new MockMediaStreamTrack("remote_video_track", "video"),
                ],
            ),
        );
        const feed = call.getFeeds().find((feed) => feed.stream.id === "remote_stream");
        expect(feed?.purpose).toBe(SDPStreamMetadataPurpose.Usermedia);
        expect(feed?.id).toBe("feed_id");
        expect(feed?.isAudioMuted()).toBeTruthy();
        expect(feed?.isVideoMuted()).not.toBeTruthy();
    });

    it("should fallback to replaceTrack() if the other side doesn't support SPDStreamMetadata", async () => {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;

        call.getOpponentMember = () => {
            return { userId: "@bob:bar.uk" } as RoomMember;
        };

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
        });

        call.setScreensharingEnabledWithoutMetadataSupport = jest.fn();

        call.setScreensharingEnabled(true);
        expect(call.setScreensharingEnabledWithoutMetadataSupport).toHaveBeenCalled();
    });

    it("should fallback to answering with no video", async () => {
        await client.httpBackend.flush();

        call.shouldAnswerWithMediaType = (wantedValue: boolean) => wantedValue;
        client.client.mediaHandler.getUserMediaStream = jest.fn().mockRejectedValue("reject");

        await call.answer(true, true);

        expect(client.client.mediaHandler.getUserMediaStream).toHaveBeenNthCalledWith(1, true, true);
        expect(client.client.mediaHandler.getUserMediaStream).toHaveBeenNthCalledWith(2, true, false);
    });

    it("should handle mid-call device changes", async () => {
        client.client.mediaHandler.getUserMediaStream = jest.fn().mockReturnValue(
            new MockMediaStream(
                "stream", [
                    new MockMediaStreamTrack("audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ],
            ),
        );

        const callPromise = call.placeVideoCall();
        await client.httpBackend.flush();
        await callPromise;

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                };
            },
        });

        await call.updateLocalUsermediaStream(
            new MockMediaStream(
                "replacement_stream",
                [
                    new MockMediaStreamTrack("new_audio_track", "audio"),
                    new MockMediaStreamTrack("video_track", "video"),
                ],
            ),
        );
        expect(call.localUsermediaStream.id).toBe("stream");
        expect(call.localUsermediaStream.getAudioTracks()[0].id).toBe("new_audio_track");
        expect(call.localUsermediaStream.getVideoTracks()[0].id).toBe("video_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "audio";
        }).track.id).toBe("new_audio_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "video";
        }).track.id).toBe("video_track");
    });

    it("should handle upgrade to video call", async () => {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;

        await call.onAnswerReceived({
            getContent: () => {
                return {
                    version: 1,
                    call_id: call.callId,
                    party_id: 'party_id',
                    answer: {
                        sdp: DUMMY_SDP,
                    },
                    [SDPStreamMetadataKey]: {},
                };
            },
        });

        await call.upgradeCall(false, true);

        expect(call.localUsermediaStream.getAudioTracks()[0].id).toBe("audio_track");
        expect(call.localUsermediaStream.getVideoTracks()[0].id).toBe("video_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "audio";
        }).track.id).toBe("audio_track");
        expect(call.usermediaSenders.find((sender) => {
            return sender?.track?.kind === "video";
        }).track.id).toBe("video_track");
    });

    describe("should handle stream replacement", () => {
        it("with both purpose and id", async () => {
            const callPromise = call.placeVoiceCall();
            await client.httpBackend.flush();
            await callPromise;

            call.getOpponentMember = () => {
                return { userId: "@bob:bar.uk" };
            };

            call.updateRemoteSDPStreamMetadata({
                "remote_stream1": {
                    purpose: SDPStreamMetadataPurpose.Usermedia,
                    id: "feed_id",
                },
            });
            call.pushRemoteFeed(new MockMediaStream("remote_stream1", []));
            const feed = call.getFeeds().find((feed) => feed.stream.id === "remote_stream1");

            call.updateRemoteSDPStreamMetadata({
                "remote_stream2": {
                    purpose: SDPStreamMetadataPurpose.Usermedia,
                    id: "feed_id",
                },
            });
            call.pushRemoteFeed(new MockMediaStream("remote_stream2", []));

            expect(feed?.stream?.id).toBe("remote_stream2");
        });

        it("with just purpose", async () => {
            const callPromise = call.placeVoiceCall();
            await client.httpBackend.flush();
            await callPromise;

            call.getOpponentMember = () => {
                return { userId: "@bob:bar.uk" };
            };

            call.updateRemoteSDPStreamMetadata({
                "remote_stream1": {
                    purpose: SDPStreamMetadataPurpose.Usermedia,
                },
            });
            call.pushRemoteFeed(new MockMediaStream("remote_stream1", []));
            const feed = call.getFeeds().find((feed) => feed.stream.id === "remote_stream1");

            call.updateRemoteSDPStreamMetadata({
                "remote_stream2": {
                    purpose: SDPStreamMetadataPurpose.Usermedia,
                },
            });
            call.pushRemoteFeed(new MockMediaStream("remote_stream2", []));

            expect(feed?.stream?.id).toBe("remote_stream2");
        });

        it("should not replace purpose is different", async () => {
            const callPromise = call.placeVoiceCall();
            await client.httpBackend.flush();
            await callPromise;

            call.getOpponentMember = () => {
                return { userId: "@bob:bar.uk" };
            };

            call.updateRemoteSDPStreamMetadata({
                "remote_stream1": {
                    purpose: SDPStreamMetadataPurpose.Usermedia,
                },
            });
            call.pushRemoteFeed(new MockMediaStream("remote_stream1", []));
            const feed = call.getFeeds().find((feed) => feed.stream.id === "remote_stream1");

            call.updateRemoteSDPStreamMetadata({
                "remote_stream2": {
                    purpose: SDPStreamMetadataPurpose.Screenshare,
                },
            });
            call.pushRemoteFeed(new MockMediaStream("remote_stream2", []));

            expect(feed?.stream?.id).toBe("remote_stream1");
        });
    });

    it("should handle SDPStreamMetadata changes", async () => {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;

        call.getOpponentMember = () => {
            return { userId: "@bob:bar.uk" };
        };

        call.updateRemoteSDPStreamMetadata({
            "remote_stream": {
                purpose: SDPStreamMetadataPurpose.Usermedia,
                audio_muted: false,
                video_muted: false,
                id: "feed_id1",
            },
        });
        call.pushRemoteFeed(new MockMediaStream("remote_stream", []));
        const feed = call.getFeeds().find((feed) => feed.stream.id === "remote_stream");

        call.onSDPStreamMetadataChangedReceived({
            getContent: () => ({
                [SDPStreamMetadataKey]: {
                    "remote_stream": {
                        purpose: SDPStreamMetadataPurpose.Screenshare,
                        audio_muted: true,
                        video_muted: true,
                        id: "feed_id2",
                    },
                },
            }),
        });

        expect(feed?.purpose).toBe(SDPStreamMetadataPurpose.Screenshare);
        expect(feed?.audioMuted).toBe(true);
        expect(feed?.videoMuted).toBe(true);
        expect(feed?.id).toBe("feed_id2");
    });

    it("should choose opponent member", async () => {
        const callPromise = call.placeVoiceCall();
        await client.httpBackend.flush();
        await callPromise;

        const opponentMember = {
            roomId: call.roomId,
            userId: "opponentUserId",
        };
        const opponentCaps = {
            "m.call.transferee": true,
            "m.call.dtmf": false,
        };
        call.chooseOpponent({
            getContent: () => ({
                version: 1,
                party_id: "party_id",
                capabilities: opponentCaps,
            }),
            sender: opponentMember,
        });

        expect(call.getOpponentMember()).toBe(opponentMember);
        expect(call.opponentPartyId).toBe("party_id");
        expect(call.opponentCaps).toBe(opponentCaps);
        expect(call.opponentCanBeTransferred()).toBe(true);
        expect(call.opponentSupportsDTMF()).toBe(false);
    });

    describe("should deduce the call type correctly", () => {
        it("if no video", async () => {
            const callPromise = call.placeVoiceCall();
            await client.httpBackend.flush();
            await callPromise;

            call.getOpponentMember = () => {
                return { userId: "@bob:bar.uk" };
            };
            call.pushRemoteFeed(new MockMediaStream("remote_stream1", []));

            expect(call.type).toBe(CallType.Voice);
        });

        it("if remote video", async () => {
            const callPromise = call.placeVoiceCall();
            await client.httpBackend.flush();
            await callPromise;

            call.getOpponentMember = () => {
                return { userId: "@bob:bar.uk" };
            };
            call.pushRemoteFeed(new MockMediaStream("remote_stream1", [new MockMediaStreamTrack("track_id", "video")]));

            expect(call.type).toBe(CallType.Video);
        });

        it("if local video", async () => {
            const callPromise = call.placeVideoCall();
            await client.httpBackend.flush();
            await callPromise;

            call.getOpponentMember = () => {
                return { userId: "@bob:bar.uk" };
            };

            expect(call.type).toBe(CallType.Video);
        });
    });

    it("should correctly generate local SDPStreamMetadata", async () => {
        const callPromise = call.placeCallWithCallFeeds([new CallFeed({
            client,
            // @ts-ignore Mock
            stream: new MockMediaStream("local_stream1", [new MockMediaStreamTrack("track_id", "audio")]),
            roomId: call.roomId,
            userId: client.getUserId(),
            id: "feed_id1",
            purpose: SDPStreamMetadataPurpose.Usermedia,
            audioMuted: false,
            videoMuted: false,
        })]);
        await client.httpBackend.flush();
        await callPromise;
        call.getOpponentMember = () => {
            return { userId: "@bob:bar.uk" };
        };
        call.pushNewLocalFeed(
            new MockMediaStream("local_stream2", [new MockMediaStreamTrack("track_id", "video")]),
            SDPStreamMetadataPurpose.Screenshare, "feed_id2",
        );
        await call.setMicrophoneMuted(true);

        expect(call.getLocalSDPStreamMetadata()).toStrictEqual({
            "local_stream1": {
                "purpose": SDPStreamMetadataPurpose.Usermedia,
                "id": "feed_id1",
                "audio_muted": true,
                "video_muted": true,
            },
            "local_stream2": {
                "purpose": SDPStreamMetadataPurpose.Screenshare,
                "id": "feed_id2",
                "audio_muted": true,
                "video_muted": false,
            },
        });
    });

    it("feed and stream getters return correctly", async () => {
        const localUsermediaStream = new MockMediaStream("local_usermedia_stream_id", []);
        const localScreensharingStream = new MockMediaStream("local_screensharing_stream_id", []);
        const remoteUsermediaStream = new MockMediaStream("remote_usermedia_stream_id", []);
        const remoteScreensharingStream = new MockMediaStream("remote_screensharing_stream_id", []);

        const callPromise = call.placeCallWithCallFeeds([
            new CallFeed({
                client,
                userId: client.getUserId(),
                // @ts-ignore Mock
                stream: localUsermediaStream,
                purpose: SDPStreamMetadataPurpose.Usermedia,
                id: "local_usermedia_feed_id",
                audioMuted: false,
                videoMuted: false,
            }),
            new CallFeed({
                client,
                userId: client.getUserId(),
                // @ts-ignore Mock
                stream: localScreensharingStream,
                purpose: SDPStreamMetadataPurpose.Screenshare,
                id: "local_screensharing_feed_id",
                audioMuted: false,
                videoMuted: false,
            }),
        ]);
        await client.httpBackend.flush();
        await callPromise;
        call.getOpponentMember = () => {
            return { userId: "@bob:bar.uk" };
        };

        call.updateRemoteSDPStreamMetadata({
            "remote_usermedia_stream_id": {
                purpose: SDPStreamMetadataPurpose.Usermedia,
                id: "remote_usermedia_feed_id",
                audio_muted: false,
                video_muted: false,
            },
            "remote_screensharing_stream_id": {
                purpose: SDPStreamMetadataPurpose.Screenshare,
                id: "remote_screensharing_feed_id",
                audio_muted: false,
                video_muted: false,
            },
        });
        call.pushRemoteFeed(remoteUsermediaStream);
        call.pushRemoteFeed(remoteScreensharingStream);

        expect(call.localUsermediaFeed.stream).toBe(localUsermediaStream);
        expect(call.localUsermediaStream).toBe(localUsermediaStream);
        expect(call.localScreensharingFeed.stream).toBe(localScreensharingStream);
        expect(call.localScreensharingStream).toBe(localScreensharingStream);
        expect(call.remoteUsermediaFeed.stream).toBe(remoteUsermediaStream);
        expect(call.remoteUsermediaStream).toBe(remoteUsermediaStream);
        expect(call.remoteScreensharingFeed.stream).toBe(remoteScreensharingStream);
        expect(call.remoteScreensharingStream).toBe(remoteScreensharingStream);
    });

    describe("supportsMatrixCall", () => {
        it("should return true when the environment is right", () => {
            expect(supportsMatrixCall()).toBe(true);
        });

        it("should return false if window or document are undefined", () => {
            global.window = undefined;
            expect(supportsMatrixCall()).toBe(false);
            global.window = prevWindow;
            global.document = undefined;
            expect(supportsMatrixCall()).toBe(false);
        });

        it("should return false if RTCPeerConnection throws", () => {
            // @ts-ignore - writing to window as we are simulating browser edge-cases
            global.window = {};
            Object.defineProperty(global.window, "RTCPeerConnection", {
                get: () => {
                    throw Error("Secure mode, naaah!");
                },
            });
            expect(supportsMatrixCall()).toBe(false);
        });

        it("should return false if RTCPeerConnection & RTCSessionDescription " +
            "& RTCIceCandidate & mediaDevices are unavailable",
        () => {
            global.window.RTCPeerConnection = undefined;
            global.window.RTCSessionDescription = undefined;
            global.window.RTCIceCandidate = undefined;
            // @ts-ignore - writing to a read-only property as we are simulating faulty browsers
            global.navigator.mediaDevices = undefined;
            expect(supportsMatrixCall()).toBe(false);
        });
    });
});
